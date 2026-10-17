import { Duration, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  AuroraPostgresEngineVersion,
  type CfnDBCluster,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { ScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

/** The schedule group that holds a deployment's one-time job schedules. */
export const jobScheduleGroup = (stage: string) => `galena-${stage}-jobs`;

/**
 * The home region's stateful core: an isolated VPC for Aurora, the telemetry table, the
 * check-results queue, the job queues and the private config bucket. No NAT gateway and no
 * Lambda in the VPC: everything reaches Aurora through the Data API.
 */
export class FoundationStack extends Stack {
  readonly database: DatabaseCluster;
  /** The RDS-managed master secret the Data API authenticates with. */
  readonly databaseSecretArn: string;
  readonly telemetry: Table;
  readonly checkResults: Queue;
  /** Holds `monitors.json`: the workers write it, the probes and the evaluator read it. */
  readonly config: Bucket;

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const { stage, telemetryCapacity, auroraMaxAcu, retainData } = props.config;
    const dataRemoval = retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const vpc = new Vpc(this, "Vpc", {
      maxAzs: 2, // Aurora needs subnets in two AZs
      natGateways: 0,
      subnetConfiguration: [
        { name: "isolated", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    Validations.of(vpc).acknowledge({
      id: "AwsSolutions-VPC7",
      reason:
        "The VPC holds only Aurora in isolated subnets; every client uses the Data API, which does not enter the VPC, so flow logs would record nothing useful.",
    });

    this.database = new DatabaseCluster(this, "Database", {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_13,
      }),
      writer: ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0, // pauses when idle; nothing may query it more often than hourly
      serverlessV2MaxCapacity: auroraMaxAcu,
      serverlessV2AutoPauseDuration: Duration.minutes(5),
      enableDataApi: true,
      iamAuthentication: true,
      // RDS keeps the password in Secrets Manager and rotates it every 7 days by itself, so no
      // rotation Lambda (which would have to live in the VPC) is needed.
      credentials: Credentials.fromUsername("galena"),
      manageMasterUserPassword: true,
      defaultDatabaseName: "galena",
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
      // What people wrote (incidents, subscribers) lives only here, so every stage keeps it:
      // guarded against deletion, kept when the stack goes, with two weeks of backups.
      backup: { retention: Duration.days(14) },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ["postgresql"],
    });
    Validations.of(this.database).acknowledge({
      id: "AwsSolutions-RDS11",
      reason:
        "Nothing connects on a port: every client uses the Data API over HTTPS, so moving the port hides nothing.",
    });

    this.databaseSecretArn = (
      this.database.node.defaultChild as CfnDBCluster
    ).attrMasterUserSecretSecretArn;

    // One table for check results, monitor state, heartbeats and region health.
    this.telemetry = new Table(this, "Telemetry", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: telemetryCapacity.read,
      writeCapacity: telemetryCapacity.write,
      timeToLiveAttribute: "ttl", // check results expire after 90 days
      removalPolicy: dataRemoval,
    });
    Validations.of(this.telemetry).acknowledge({
      id: "AwsSolutions-DDB3",
      reason:
        "Telemetry is reconstructible and expires after 90 days; point-in-time recovery would cost more than the data is worth.",
    });

    // Probe results, grouped per monitor so each monitor is evaluated in order.
    const deadLetters = new Queue(this, "CheckResultsDlq", {
      fifo: true,
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    Validations.of(deadLetters).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue; an alarm on its depth replaces a queue behind it.",
    });
    this.checkResults = new Queue(this, "CheckResults", {
      fifo: true,
      contentBasedDeduplication: false, // probes send {monitorId}#{region}#{epochMinute}
      visibilityTimeout: Duration.minutes(3),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 5 },
    });

    // Alarms tell the operator through this topic. Nothing subscribes to it here: the operator
    // subscribes an address once, so none is kept in the repository.
    const alarms = new Topic(this, "Alarms", {
      topicName: `galena-${stage}-alarms`,
      enforceSSL: true,
    });
    Validations.of(alarms).acknowledge({
      id: "AwsSolutions-SNS2",
      reason:
        "CloudWatch can publish only to topics under a customer-managed key, which costs more than this budget; an alarm message holds its name and state, in transit over TLS only.",
    });
    const notify = new SnsAction(alarms);
    deadLetters
      .metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) })
      .createAlarm(this, "DeadLetterAlarm", {
        alarmDescription: "Check results failed five times and wait in the dead-letter queue.",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);
    // Every probe region sends results each minute, so silence means they all stopped.
    this.checkResults
      .metricNumberOfMessagesSent({ period: Duration.minutes(5) })
      .createAlarm(this, "NoCheckResultsAlarm", {
        alarmDescription: "No probe region has sent a check result for 10 minutes.",
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.BREACHING,
      })
      .addAlarmAction(notify);

    // Background jobs. Message groups are lanes: one job at a time each, side by side across
    // groups. HTML builds have their own queue so a slow build holds up no other job. Scheduler
    // sends jobs for later into the jobs queue; it can't set a deduplication id, so the queues
    // dedupe by content (every message carries its key). Visibility is six times each function's
    // timeout, as AWS advises for event sources.
    const jobQueue = (id: string, visibilityTimeout: Duration) => {
      const deadLetters = new Queue(this, `${id}Dlq`, {
        fifo: true,
        retentionPeriod: Duration.days(14),
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
      Validations.of(deadLetters).acknowledge({
        id: "AwsSolutions-SQS3",
        reason: "This is the dead-letter queue; an alarm on its depth replaces a queue behind it.",
      });
      // A job that failed for good, or crashed or timed out five times, is lost work.
      deadLetters
        .metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) })
        .createAlarm(this, `${id}DeadLetterAlarm`, {
          alarmDescription: `A ${id.toLowerCase()} message failed for good and waits in the dead-letter queue.`,
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        })
        .addAlarmAction(notify);
      const queue = new Queue(this, id, {
        fifo: true,
        contentBasedDeduplication: true,
        visibilityTimeout,
        retentionPeriod: Duration.days(14),
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        deadLetterQueue: { queue: deadLetters, maxReceiveCount: 5 },
      });
      // A job's retries wait under four minutes in all and a build takes a few; older means a
      // lane stopped moving or the function can't start, long before five receives end in the
      // dead-letter queue.
      queue
        .metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) })
        .createAlarm(this, `${id}AgeAlarm`, {
          alarmDescription: `A ${id.toLowerCase()} message has waited over 15 minutes: a lane is stuck or its function can't start.`,
          threshold: Duration.minutes(15).toSeconds(),
          evaluationPeriods: 2,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        })
        .addAlarmAction(notify);
      return { queue, deadLetters };
    };
    const jobs = jobQueue("Jobs", Duration.minutes(12));
    const builds = jobQueue("Builds", Duration.minutes(30));

    new ScheduleGroup(this, "JobSchedules", {
      scheduleGroupName: jobScheduleGroup(stage),
    });
    // Scheduler sends a job for later into its queue as this role, for this group only. AWS
    // checks the source as the schedule group's ARN: a schedule's ARN never matches.
    const scheduler = new Role(this, "JobScheduler", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": this.account,
            "aws:SourceArn": this.formatArn({
              service: "scheduler",
              resource: "schedule-group",
              resourceName: jobScheduleGroup(stage),
            }),
          },
        },
      }),
    });
    // A job Scheduler couldn't deliver within an hour waits here with what it held, for a person
    // to send again. Scheduler can only use a standard queue for this.
    const scheduleDeadLetters = new Queue(this, "ScheduleDlq", {
      retentionPeriod: Duration.days(14),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    Validations.of(scheduleDeadLetters).acknowledge({
      id: "AwsSolutions-SQS3",
      reason:
        "This is Scheduler's dead-letter queue; an alarm on its depth replaces a queue behind it.",
    });
    scheduleDeadLetters
      .metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) })
      .createAlarm(this, "ScheduleDeadLetterAlarm", {
        alarmDescription:
          "Scheduler could not deliver a job for an hour; it waits in the dead-letter queue.",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);
    scheduler.addToPolicy(
      new PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [jobs.queue.queueArn, builds.queue.queueArn, scheduleDeadLetters.queueArn],
      }),
    );

    this.config = new Bucket(this, "Config", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: dataRemoval,
    });
    Validations.of(this.config).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "Holds one file that the workers rebuild from the database on every change; access logs would mostly record the probes reading it every minute.",
    });

    // Non-secret identifiers that other stacks and the CLI read from SSM, without exports.
    const parameters = {
      "database-cluster-arn": this.database.clusterArn,
      "database-secret-arn": this.databaseSecretArn,
      "telemetry-table": this.telemetry.tableName,
      "check-results-queue-url": this.checkResults.queueUrl,
      "check-results-queue-arn": this.checkResults.queueArn,
      "config-bucket": this.config.bucketName,
      "alarm-topic-arn": alarms.topicArn,
      "jobs-queue-url": jobs.queue.queueUrl,
      "jobs-queue-arn": jobs.queue.queueArn,
      "jobs-dead-letter-url": jobs.deadLetters.queueUrl,
      "jobs-dead-letter-arn": jobs.deadLetters.queueArn,
      "builds-queue-url": builds.queue.queueUrl,
      "builds-queue-arn": builds.queue.queueArn,
      "builds-dead-letter-url": builds.deadLetters.queueUrl,
      "builds-dead-letter-arn": builds.deadLetters.queueArn,
      "job-scheduler-role-arn": scheduler.roleArn,
      "schedule-dead-letter-arn": scheduleDeadLetters.queueArn,
    };
    for (const [name, value] of Object.entries(parameters)) {
      new StringParameter(this, `Param-${name}`, {
        parameterName: `/galena/${stage}/${name}`,
        stringValue: value,
      });
    }
  }
}
