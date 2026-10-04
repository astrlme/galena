import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";
import { bundling, source } from "./bundling.ts";

/** apps/evaluator on the check-results queue, in the home region. */
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
    const triggerSecret = `/galena/${stage}/trigger-secret-key`;

    const logGroup = new LogGroup(this, "EvaluatorLogs", { retention: RetentionDays.ONE_MONTH });
    const role = new Role(this, "EvaluatorRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
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
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: triggerSecret.slice(1),
          }),
        ],
      }),
    ]) {
      role.addToPolicy(statement);
    }

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
      environment: {
        GLN_TELEMETRY_TABLE: table,
        GLN_CONFIG_BUCKET: configBucket,
        GLN_PROBE_REGIONS: probeRegions.join(","),
        GLN_TRIGGER_SECRET_PARAM: triggerSecret,
      },
      bundling,
    });
    // Up to 10 per batch; a failed message is retried alone while the rest are deleted.
    evaluator.addEventSource(
      new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }),
    );

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
  }
}
