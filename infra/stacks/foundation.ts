import { Duration, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  AuroraPostgresEngineVersion,
  type CfnDBCluster,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { StageConfig } from "../config/stages.ts";

/**
 * The home region's stateful core: KMS key, an isolated VPC
 * for Aurora, the telemetry table and the check-results queue. No NAT gateway and no Lambda in
 * the VPC: everything reaches Aurora through the Data API.
 */
export class FoundationStack extends Stack {
  readonly key: Key;
  readonly database: DatabaseCluster;
  /** The RDS-managed master secret the Data API authenticates with. */
  readonly databaseSecretArn: string;
  readonly telemetry: Table;
  readonly checkResults: Queue;

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const { stage, telemetryCapacity, auroraMaxAcu } = props.config;
    const isProd = stage === "prod";
    const dataRemoval = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // Envelope encryption for integration credentials.
    this.key = new Key(this, "Key", {
      alias: `galena/${stage}`,
      enableKeyRotation: true,
      removalPolicy: dataRemoval,
    });

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
      backup: { retention: Duration.days(isProd ? 14 : 1) },
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ["postgresql"],
    });
    for (const [id, reason] of [
      [
        "AwsSolutions-RDS11",
        "Nothing connects on a port: every client uses the Data API over HTTPS, so moving the port hides nothing.",
      ],
      ...(isProd
        ? []
        : [["AwsSolutions-RDS10", "Dev data is disposable; prod has deletion protection."]]),
    ] as const) {
      Validations.of(this.database).acknowledge({ id, reason });
    }

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

    // Non-secret identifiers for tools outside CDK, such as the trigger.dev workers.
    const parameters = {
      "database-cluster-arn": this.database.clusterArn,
      "database-secret-arn": this.databaseSecretArn,
      "telemetry-table": this.telemetry.tableName,
      "check-results-queue-url": this.checkResults.queueUrl,
      "kms-key-arn": this.key.keyArn,
    };
    for (const [name, value] of Object.entries(parameters)) {
      new StringParameter(this, `Param-${name}`, {
        parameterName: `/galena/${stage}/${name}`,
        stringValue: value,
      });
    }
  }
}
