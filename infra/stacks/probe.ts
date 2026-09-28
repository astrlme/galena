import { Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, type CfnFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import {
  ContextAttribute,
  Schedule,
  ScheduleExpression,
  ScheduleTargetInput,
} from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";

/**
 * One probe region: every minute the Scheduler runs apps/probe, which reads `monitors.json` from
 * the home region's config bucket and sends its results to the home region's queue.
 */
export class ProbeStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { config: StageConfig; configBucket: IBucket; queue: IQueue },
  ) {
    super(scope, id, props);
    const { configBucket, queue } = props;

    const logGroup = new LogGroup(this, "ProbeLogs", { retention: RetentionDays.ONE_MONTH });
    // Its own role: its logs, the config file and the queue, nothing else.
    const role = new Role(this, "ProbeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [configBucket.arnForObjects("monitors.json")],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [queue.queueArn] }),
    );

    const probe = new NodejsFunction(this, "Probe", {
      entry: source("apps/probe/src/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // Checks time out after 10 s and run 50 at a time, so a wide outage still fits.
      timeout: Duration.seconds(50),
      role,
      logGroup,
      environment: {
        GLN_HOME_REGION: props.config.homeRegion,
        GLN_CONFIG_BUCKET: configBucket.bucketName,
        GLN_QUEUE_URL: queue.queueUrl,
      },
      bundling,
    });

    // The scheduled time, not the clock at send time, names the minute a result belongs to, so a
    // late or repeated run is deduplicated by the queue.
    new Schedule(this, "EveryMinute", {
      schedule: ScheduleExpression.cron({ minute: "*" }),
      target: new LambdaInvoke(probe, {
        input: ScheduleTargetInput.fromObject({ scheduledAt: ContextAttribute.scheduledTime }),
      }),
    });
    Validations.of(this).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(probe.node.defaultChild as CfnFunction)}.Arn>:*]`,
      reason:
        "grantInvoke also covers the function's versions and aliases (`:*`); the Scheduler's role may invoke only this function.",
    });
  }
}
