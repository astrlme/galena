import { CfnOutput, Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import {
  HttpApi,
  HttpStage,
  LogGroupLogDestination,
  type ThrottleSettings,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";
import { dataApiAccess } from "./data-api.ts";

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

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
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
    // The auth secret, the trigger.dev secret key, the app key and the setup token are
    // SecureStrings made once outside CloudFormation; the Web stack writes the public URL. All
    // are read at cold start. Without the setup token, first-run setup is refused.
    const authSecret = `/galena/${stage}/auth-secret`;
    const triggerSecret = `/galena/${stage}/trigger-secret-key`;
    const appKey = `/galena/${stage}/app-key`;
    const setupToken = `/galena/${stage}/setup-token`;
    const publicUrl = `/galena/${stage}/public-url`;
    // Optional: the Slack app's client id and secrets, as JSON. Without it, Slack is off.
    const slackApp = `/galena/${stage}/slack-app`;
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [authSecret, triggerSecret, appKey, setupToken, publicUrl, slackApp].map(
          (name) =>
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
        GLN_TRIGGER_SECRET_PARAM: triggerSecret,
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
    const migrate = new NodejsFunction(this, "Migrate", {
      entry: source("apps/api/src/migrate.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // The first statement after Aurora pauses waits ~15 s for it to resume.
      timeout: Duration.minutes(2),
      role: lambdaRole("MigrateRole", migrationLogs),
      logGroup: migrationLogs,
      environment: { GLN_STAGE: stage, ...database },
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
    new Trigger(this, "MigrateOnDeploy", { handler: migrate, executeOnHandlerChange: true });

    this.api = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("Lambda", handler),
      createDefaultStage: false,
    });
    const accessLogs = new LogGroup(this, "AccessLogs", { retention: RetentionDays.ONE_MONTH });
    new HttpStage(this, "DefaultStage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 } satisfies ThrottleSettings,
      accessLogSettings: { destination: new LogGroupLogDestination(accessLogs) },
    });

    // The app authenticates every route itself: sessions, API keys, webhook signatures.
    for (const route of this.api.node.findAll()) {
      if (route.node.id === "DefaultRoute") {
        Validations.of(route).acknowledge({
          id: "AwsSolutions-APIG4",
          reason:
            "Hono checks auth per route (Better Auth sessions, API keys, webhook signatures); public routes such as /health and /hooks are public by design.",
        });
      }
    }

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
  }
}
