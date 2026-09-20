import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import {
  HttpApi,
  HttpStage,
  LogGroupLogDestination,
  type ThrottleSettings,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

const entry = fileURLToPath(new URL("../../apps/api/src/lambda.ts", import.meta.url));

/** apps/api on Lambda behind an HTTP API. */
export class ApiStack extends Stack {
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);

    const logGroup = new LogGroup(this, "HandlerLogs", { retention: RetentionDays.ONE_MONTH });
    // Its own role that can only write its own logs, instead of AWSLambdaBasicExecutionRole.
    const role = new Role(this, "HandlerRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);

    const handler = new NodejsFunction(this, "Handler", {
      entry,
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // API Gateway gives up at 30 s; the first query after Aurora pauses can take ~15 s.
      timeout: Duration.seconds(29),
      role,
      logGroup,
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: true,
        mainFields: ["module", "main"],
        // Some dependencies still call require() inside an ES module bundle.
        banner:
          "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
      },
    });

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
