import { Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { ComparisonOperator, MathExpression, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, type CfnFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  ContextAttribute,
  Schedule,
  ScheduleExpression,
  ScheduleTargetInput,
} from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";
import { jobAccess } from "./job-access.ts";

/**
 * apps/evaluator on the check-results queue, in the home region, and the heartbeat sweeper from
 * the same code every minute.
 */
export class DetectionStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const { stage, probeRegions } = props.config;
    // Foundation publishes these; reading them at deploy time keeps the stacks free of exports.
    const param = (name: string) =>
      StringParameter.valueForStringParameter(this, `/galena/${stage}/${name}`);
    const table = param("telemetry-table");
    const configBucket = param("config-bucket");
    const queue = Queue.fromQueueAttributes(this, "CheckResults", {
      queueArn: param("check-results-queue-arn"),
      fifo: true,
    });
    const jobs = jobAccess(this, stage);

    /** Telemetry, `monitors.json` and one message per transition: nothing else, no schedule. */
    const detectionRole = (id: string, logGroup: LogGroup) => {
      const role = new Role(this, id, { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
      logGroup.grantWrite(role);
      for (const statement of [
        new PolicyStatement({
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:BatchGetItem"],
          resources: [
            this.formatArn({ service: "dynamodb", resource: "table", resourceName: table }),
          ],
        }),
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [`arn:${this.partition}:s3:::${configBucket}/monitors.json`],
        }),
      ]) {
        role.addToPolicy(statement);
      }
      jobs.grant(role);
      return role;
    };

    const logGroup = new LogGroup(this, "EvaluatorLogs", { retention: RetentionDays.ONE_MONTH });
    const role = detectionRole("EvaluatorRole", logGroup);
    // Optional, made by the operator: the ping URL of an outside dead-man's switch, read at cold
    // start. Detection pings it at most once a minute.
    const heartbeat = `/galena/${stage}/evaluator-heartbeat`;
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: heartbeat.slice(1),
          }),
        ],
      }),
    );

    const environment = {
      GLN_TELEMETRY_TABLE: table,
      GLN_CONFIG_BUCKET: configBucket,
      GLN_PROBE_REGIONS: probeRegions.join(","),
      ...jobs.environment,
    };
    const evaluator = new NodejsFunction(this, "Evaluator", {
      entry: source("apps/evaluator/src/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // A sixth of the queue's 3-minute visibility timeout, as AWS advises for event sources.
      timeout: Duration.seconds(30),
      role,
      logGroup,
      environment: { ...environment, GLN_HEARTBEAT_PARAM: heartbeat },
      bundling,
    });
    // Up to 10 per batch; a failed message is retried alone while the rest are deleted.
    evaluator.addEventSource(
      new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }),
    );

    // Heartbeat monitors: each minute's verdict from their newest check-in, through the same
    // detection. It reads no outside heartbeat URL, so a heartbeat outage can't hide behind it.
    const sweeperLogs = new LogGroup(this, "SweeperLogs", { retention: RetentionDays.ONE_MONTH });
    const sweeper = new NodejsFunction(this, "HeartbeatSweeper", {
      entry: source("apps/evaluator/src/handler.ts"),
      handler: "sweep",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      role: detectionRole("SweeperRole", sweeperLogs),
      logGroup: sweeperLogs,
      environment,
      bundling,
      // The next minute judges every heartbeat afresh; a late retry would only race it.
      retryAttempts: 0,
    });
    // The scheduled time names the minute each verdict belongs to, so a repeated run is skipped.
    new Schedule(this, "SweepEveryMinute", {
      schedule: ScheduleExpression.cron({ minute: "*" }),
      target: new LambdaInvoke(sweeper, {
        input: ScheduleTargetInput.fromObject({ scheduledAt: ContextAttribute.scheduledTime }),
        retryAttempts: 0,
        maxEventAge: Duration.minutes(1),
      }),
    });
    Validations.of(this).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(sweeper.node.defaultChild as CfnFunction)}.Arn>:*]`,
      reason:
        "grantInvoke also covers the function's versions and aliases (`:*`); the Scheduler's role may invoke only this function.",
    });

    // To Foundation's alarm topic: a failing evaluator holds every monitor's state still, and a
    // throttled one means the account's concurrency ran out.
    const notify = new SnsAction(Topic.fromTopicArn(this, "Alarms", param("alarm-topic-arn")));
    evaluator
      .metricErrors({ period: Duration.minutes(5) })
      .createAlarm(this, "EvaluatorErrorsAlarm", {
        alarmDescription: "The evaluator failed in two 5-minute periods in a row.",
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);
    evaluator
      .metricThrottles({ period: Duration.minutes(5) })
      .createAlarm(this, "EvaluatorThrottlesAlarm", {
        alarmDescription: "Lambda throttled the evaluator: the account's concurrency ran out.",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);
    // A failing or stopped sweeper leaves every heartbeat monitor where it was, so silence looks
    // fine: one alarm for errors and for a schedule that stopped invoking it.
    const period = Duration.minutes(5);
    new MathExpression({
      expression: "IF(FILL(invocations, 0) < 1 OR FILL(errors, 0) > 0, 1, 0)",
      usingMetrics: {
        invocations: sweeper.metricInvocations({ period }),
        errors: sweeper.metricErrors({ period }),
      },
      period,
      label: "Sweeper failing or not running",
    })
      .createAlarm(this, "SweeperAlarm", {
        alarmDescription:
          "The heartbeat sweeper failed, or wasn't invoked, in two 5-minute periods in a row.",
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.BREACHING,
      })
      .addAlarmAction(notify);
  }
}
