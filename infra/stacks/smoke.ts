import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal, WebIdentityPrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  Code,
  FunctionUrlAuthType,
  Function as LambdaFunction,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

const GITHUB_OIDC = "token.actions.githubusercontent.com";

/**
 * The deployed smoke test's props: a public endpoint the Smoke workflow stops (reserved
 * concurrency 0, so its URL answers 429) and restarts, and the role that workflow assumes.
 */
export class SmokeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const { stage, github, probeRegions } = props.config;

    const logGroup = new LogGroup(this, "TargetLogs", { retention: RetentionDays.ONE_MONTH });
    const targetRole = new Role(this, "TargetRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(targetRole);
    const target = new LambdaFunction(this, "Target", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(3),
      handler: "index.handler",
      code: Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, headers: { "content-type": "text/plain" }, body: "ok" });',
      ),
      role: targetRole,
      logGroup,
    });
    // Public on purpose: the probes check it like any other monitored URL.
    const url = target.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    const param = (name: string) => `/galena/${stage}/${name}`;
    const parameters = {
      "smoke-target-function": target.functionName,
      "smoke-target-url": url.url,
      "probe-regions": probeRegions.join(","),
    };
    for (const [name, value] of Object.entries(parameters)) {
      new StringParameter(this, `Param-${name}`, {
        parameterName: param(name),
        stringValue: value,
      });
    }

    // Assumed by the Smoke workflow on the deploy ref, like the deploy role.
    const role = new Role(this, "GitHubSmokeRole", {
      roleName: `galena-${stage}-github-smoke`,
      description: `GitHub Actions on ${github.repository} ${github.deployRef} running the ${stage} smoke test`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(
        `arn:${this.partition}:iam::${this.account}:oidc-provider/${GITHUB_OIDC}`,
        {
          StringEquals: {
            [`${GITHUB_OIDC}:aud`]: "sts.amazonaws.com",
            [`${GITHUB_OIDC}:sub`]: `${github.oidcSubject}:ref:${github.deployRef}`,
          },
        },
      ),
    });
    const telemetry = StringParameter.valueForStringParameter(this, param("telemetry-table"));
    const configBucket = StringParameter.valueForStringParameter(this, param("config-bucket"));
    const ssmArn = (name: string) =>
      this.formatArn({ service: "ssm", resource: "parameter", resourceName: param(name).slice(1) });
    for (const statement of [
      new PolicyStatement({
        actions: ["lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"],
        resources: [target.functionArn],
      }),
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [
          this.formatArn({ service: "dynamodb", resource: "table", resourceName: telemetry }),
        ],
      }),
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`arn:${this.partition}:s3:::${configBucket}/monitors.json`],
      }),
      // The trigger.dev key counts `monitor.state-changed` runs; the rest locate things.
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          "telemetry-table",
          "config-bucket",
          "trigger-secret-key",
          ...Object.keys(parameters),
        ].map(ssmArn),
      }),
    ]) {
      role.addToPolicy(statement);
    }

    new CfnOutput(this, "SmokeRoleArn", { value: role.roleArn });
    new CfnOutput(this, "TargetUrl", { value: url.url });
  }
}
