import { CfnOutput, Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import {
  type CfnStage,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
  type ThrottleSettings,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";
import { dataApiAccess } from "./data-api.ts";
import { jobAccess } from "./job-access.ts";

/**
 * CloudFront adds this header, holding the origin secret, to every request it forwards to the
 * API, and the API refuses requests without it: the execute-api URL is public, and there a caller
 * could forge the CloudFront-Viewer-Address that per-visitor limits trust.
 */
export const ORIGIN_HEADER = "x-galena-origin";
export const originSecretName = (stage: string) => `galena/${stage}/origin-secret`;
/** First-run setup sends the deployment's setup token in this header. */
export const SETUP_TOKEN_HEADER = "x-galena-setup-token";

/** apps/api on Lambda behind an HTTP API. */
export class ApiStack extends Stack {
  readonly api: HttpApi;

  /** `version` is the release being deployed, which the stack records for `galena deploy`. */
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { config: StageConfig; version: string },
  ) {
    super(scope, id, props);

    const { stage, probeRegions, pageRegions } = props.config;
    const { environment: database, role: lambdaRole } = dataApiAccess(this, stage);

    const logGroup = new LogGroup(this, "HandlerLogs", { retention: RetentionDays.ONE_MONTH });
    const role = lambdaRole("HandlerRole", logGroup);
    // The dashboard reads monitor state and recent results; only the evaluator writes them.
    const telemetryTable = StringParameter.valueForStringParameter(
      this,
      `/galena/${stage}/telemetry-table`,
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["dynamodb:BatchGetItem", "dynamodb:Query"],
        resources: [
          this.formatArn({ service: "dynamodb", resource: "table", resourceName: telemetryTable }),
        ],
      }),
    );
    // The auth secret, the app key and the setup token are SecureStrings made once outside
    // CloudFormation; the Web stack writes the public URL. All are read at cold start. Without
    // the setup token, first-run setup is refused.
    const authSecret = `/galena/${stage}/auth-secret`;
    const appKey = `/galena/${stage}/app-key`;
    const setupToken = `/galena/${stage}/setup-token`;
    const publicUrl = `/galena/${stage}/public-url`;
    // Optional: the Slack app's client id and secrets, as JSON. Without it, Slack is off.
    const slackApp = `/galena/${stage}/slack-app`;
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [authSecret, appKey, setupToken, publicUrl, slackApp].map((name) =>
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );

    // Generated here, copied to the page region, where the status page's distribution reads it.
    const originSecret = new Secret(this, "OriginSecret", {
      secretName: originSecretName(stage),
      description: "Sent by CloudFront to the API, which refuses requests without it",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      replicaRegions: [{ region: pageRegions.primary }],
    });
    originSecret.grantRead(role);
    const originSecretParam = `/aws/reference/secretsmanager/${originSecretName(stage)}`;
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: originSecretParam.slice(1),
          }),
        ],
      }),
    );
    Validations.of(originSecret).acknowledge({
      id: "AwsSolutions-SMG4",
      reason:
        "CloudFront holds a copy in its origin settings, so a rotation means a redeploy; it only proves a request came through CloudFront.",
    });

    // Changes, alerts and Slack start jobs; a change also arms its one-minute backstop.
    const jobs = jobAccess(this, stage);
    jobs.grant(role, { schedule: true });

    const handler = new NodejsFunction(this, "Handler", {
      entry: source("apps/api/src/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // API Gateway gives up at 30 s; the first query after Aurora pauses can take ~15 s.
      timeout: Duration.seconds(29),
      role,
      logGroup,
      environment: {
        GLN_STAGE: stage,
        ...database,
        GLN_AUTH_SECRET_PARAM: authSecret,
        ...jobs.environment,
        GLN_APP_KEY_PARAM: appKey,
        GLN_SETUP_TOKEN_PARAM: setupToken,
        GLN_SLACK_APP_PARAM: slackApp,
        GLN_PUBLIC_URL_PARAM: publicUrl,
        GLN_ORIGIN_SECRET_PARAM: originSecretParam,
        GLN_TELEMETRY_TABLE: telemetryTable,
        GLN_PROBE_REGIONS: probeRegions.join(","),
        // Without it the deployment sends no email, and the API takes no subscriptions.
        ...(props.config.email ? { GLN_EMAIL_FROM: props.config.email.from } : {}),
      },
      bundling,
    });

    // Migrations run on every deploy that changes them: a Trigger invokes this after the update.
    const migrationLogs = new LogGroup(this, "MigrateLogs", { retention: RetentionDays.ONE_MONTH });
    const migrations = source("packages/db/migrations");
    // Written by the migrations, not by CloudFormation, so a stack rollback can't undo it.
    const schemaParam = `/galena/${stage}/schema`;
    const migrateRole = lambdaRole("MigrateRole", migrationLogs);
    migrateRole.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: schemaParam.slice(1),
          }),
        ],
      }),
    );
    const migrate = new NodejsFunction(this, "Migrate", {
      entry: source("apps/api/src/migrate.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // The first statement after Aurora pauses waits ~15 s for it to resume.
      timeout: Duration.minutes(2),
      role: migrateRole,
      logGroup: migrationLogs,
      environment: { GLN_STAGE: stage, GLN_SCHEMA_PARAM: schemaParam, ...database },
      bundling: {
        ...bundling,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_: string, outputDir: string) => [
            `node -e "require('node:fs').cpSync(process.argv[1], process.argv[2], { recursive: true })" "${migrations}" "${outputDir}/migrations"`,
          ],
        },
      },
    });
    const migrateOnDeploy = new Trigger(this, "MigrateOnDeploy", {
      handler: migrate,
      executeOnHandlerChange: true,
    });
    // The release, updated once its migrations ran. `galena deploy` refuses an older one; the
    // schema record above guards the database, since a rollback after the migrations committed
    // would put this back.
    const version = new StringParameter(this, "Version", {
      parameterName: `/galena/${stage}/version`,
      stringValue: props.version,
      description: "The Galena release this deployment runs",
    });
    migrateOnDeploy.executeBefore(version);

    const integration = new HttpLambdaIntegration("Lambda", handler);
    this.api = new HttpApi(this, "HttpApi", {
      defaultIntegration: integration,
      createDefaultStage: false,
    });
    // The paths anyone can call without signing in get their own, lower limits, so a flood of
    // them can't take every request the stage allows. Throttled requests never reach the Lambda.
    const openPaths = {
      "/auth/{proxy+}": { rateLimit: 5, burstLimit: 10 },
      "/public/{proxy+}": { rateLimit: 2, burstLimit: 5 },
      "/hooks/{proxy+}": { rateLimit: 10, burstLimit: 20 },
      "/slack/{proxy+}": { rateLimit: 5, burstLimit: 10 },
    } satisfies Record<string, ThrottleSettings>;
    const routes = Object.keys(openPaths).flatMap((path) =>
      this.api.addRoutes({ path, methods: [HttpMethod.ANY], integration }),
    );
    const accessLogs = new LogGroup(this, "AccessLogs", { retention: RetentionDays.ONE_MONTH });
    const defaultStage = new HttpStage(this, "DefaultStage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      // A single-tenant dashboard asks for a few requests a second at most.
      throttle: { rateLimit: 20, burstLimit: 40 } satisfies ThrottleSettings,
      accessLogSettings: { destination: new LogGroupLogDestination(accessLogs) },
    });
    (defaultStage.node.defaultChild as CfnStage).routeSettings = Object.fromEntries(
      Object.entries(openPaths).map(([path, limit]) => [
        `ANY ${path}`,
        // A raw CloudFormation map: CDK passes its keys through as they are.
        { ThrottlingRateLimit: limit.rateLimit, ThrottlingBurstLimit: limit.burstLimit },
      ]),
    );
    // Route settings name routes that must exist first.
    for (const route of routes) defaultStage.node.addDependency(route);

    // The app authenticates every route itself: sessions, API keys, webhook signatures.
    for (const route of this.api.node.findAll()) {
      if (route.node.id === "DefaultRoute" || routes.some((r) => r.node === route.node)) {
        Validations.of(route).acknowledge({
          id: "AwsSolutions-APIG4",
          reason:
            "Hono checks auth per route (Better Auth sessions, API keys, webhook signatures); public routes such as /health and /hooks are public by design.",
        });
      }
    }

    // Far more requests than one team's dashboard makes: someone else is calling, and every call
    // they get through can wake Aurora.
    const alarms = StringParameter.valueForStringParameter(
      this,
      `/galena/${stage}/alarm-topic-arn`,
    );
    const notify = new SnsAction(Topic.fromTopicArn(this, "Alarms", alarms));
    this.api
      .metricCount({ statistic: "Sum", period: Duration.hours(1) })
      .createAlarm(this, "TrafficAlarm", {
        alarmDescription:
          "The API answered over 5,000 requests in an hour. Look for unexpected callers in its logs.",
        threshold: 5_000,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);

    // A change saved while the job queue was unreachable commits all the same and waits for the
    // six-hourly outbox sweep; a new workspace's first publish waits for the hourly heartbeat.
    // The API logs each job it couldn't start as "<job> was not triggered", and this says so.
    new MetricFilter(this, "UntriggeredJobs", {
      logGroup,
      filterPattern: FilterPattern.allTerms("was not triggered"),
      metricNamespace: "Galena",
      metricName: "untriggered_jobs",
      metricValue: "1",
    })
      .metric({ statistic: "Sum", period: Duration.minutes(5) })
      .createAlarm(this, "UntriggeredJobsAlarm", {
        alarmDescription:
          "The API couldn't start a job, so a saved change waits for the outbox sweep, up to six hours. Check SQS and Scheduler in the home region, and the API's log for the reason.",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
  }
}
