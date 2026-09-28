import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import {
  HttpApi,
  HttpStage,
  LogGroupLogDestination,
  type ThrottleSettings,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Trigger } from "aws-cdk-lib/triggers";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

const source = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const bundling = {
  format: OutputFormat.ESM,
  target: "node24",
  minify: true,
  sourceMap: true,
  mainFields: ["module", "main"],
  // Some dependencies still call require() inside an ES module bundle.
  banner:
    "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
};

/** apps/api on Lambda behind an HTTP API. */
export class ApiStack extends Stack {
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);

    const { stage } = props.config;
    // Foundation publishes these for anything outside it; reading them at deploy time keeps the
    // stacks free of CloudFormation exports.
    const clusterArn = StringParameter.valueForStringParameter(
      this,
      `/galena/${stage}/database-cluster-arn`,
    );
    const secretArn = StringParameter.valueForStringParameter(
      this,
      `/galena/${stage}/database-secret-arn`,
    );
    const database = {
      GLN_DB_CLUSTER_ARN: clusterArn,
      GLN_DB_SECRET_ARN: secretArn,
      GLN_DB_NAME: "galena",
    };
    const dataApi = [
      new PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ],
        resources: [clusterArn],
      }),
      new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [secretArn] }),
    ];
    // Its own role that can only write its own logs, instead of AWSLambdaBasicExecutionRole.
    const lambdaRole = (id: string, logGroup: LogGroup) => {
      const role = new Role(this, id, { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
      logGroup.grantWrite(role);
      for (const statement of dataApi) role.addToPolicy(statement);
      return role;
    };

    const logGroup = new LogGroup(this, "HandlerLogs", { retention: RetentionDays.ONE_MONTH });
    const role = lambdaRole("HandlerRole", logGroup);
    // The auth secret and the trigger.dev secret key are SecureStrings made once outside
    // CloudFormation; the Web stack writes the public URL. All are read at cold start.
    const authSecret = `/galena/${stage}/auth-secret`;
    const triggerSecret = `/galena/${stage}/trigger-secret-key`;
    const publicUrl = `/galena/${stage}/public-url`;
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [authSecret, triggerSecret, publicUrl].map((name) =>
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );

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
        GLN_PUBLIC_URL_PARAM: publicUrl,
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
