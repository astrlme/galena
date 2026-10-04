import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, test } from "vitest";
import { checkSharedFreeTier, type StageConfig, stages } from "../config/stages.ts";
import { FoundationStack } from "../stacks/foundation.ts";

function synth(config: StageConfig) {
  const app = new App();
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new FoundationStack(app, "Foundation", { config });
  return { app, template: Template.fromStack(stack) };
}

const dev = synth(stages.dev);
const prod = synth(stages.prod);
const resources = (type: string) => Object.values(dev.template.findResources(type));

describe("no NAT gateway, no Lambda in a VPC", () => {
  test("has no NAT gateway, internet gateway or public subnet", () => {
    dev.template.resourceCountIs("AWS::EC2::NatGateway", 0);
    dev.template.resourceCountIs("AWS::EC2::InternetGateway", 0);
    for (const subnet of resources("AWS::EC2::Subnet")) {
      expect(subnet.Properties.MapPublicIpOnLaunch).not.toBe(true);
    }
  });

  test("puts no Lambda function inside the VPC", () => {
    for (const fn of resources("AWS::Lambda::Function")) {
      expect(fn.Properties.VpcConfig).toBeUndefined();
    }
  });
});

test("Aurora scales to zero, answers the Data API and encrypts storage", () => {
  dev.template.hasResourceProperties("AWS::RDS::DBCluster", {
    Engine: "aurora-postgresql",
    EnableHttpEndpoint: true,
    StorageEncrypted: true,
    ServerlessV2ScalingConfiguration: {
      MinCapacity: 0,
      MaxCapacity: stages.dev.auroraMaxAcu,
      SecondsUntilAutoPause: 300,
    },
  });
});

test("RDS manages and rotates the database password; no hand-made secret exists", () => {
  dev.template.hasResourceProperties("AWS::RDS::DBCluster", {
    ManageMasterUserPassword: true,
    MasterUsername: "galena",
    MasterUserPassword: Match.absent(),
  });
  dev.template.resourceCountIs("AWS::SecretsManager::Secret", 0);
});

test("telemetry is provisioned within the free tier, with TTL", () => {
  dev.template.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: Match.absent(), // CloudFormation omits it for provisioned, its default
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
  });
  expect(() => checkSharedFreeTier(Object.values(stages))).not.toThrow();
  const greedy = { ...stages.prod, telemetryCapacity: { read: 21, write: 20 } };
  expect(() => checkSharedFreeTier([stages.dev, greedy])).toThrow(/read capacity adds up to 26/);
});

test("check results use a FIFO queue with a FIFO dead-letter queue", () => {
  const queues = resources("AWS::SQS::Queue");
  expect(queues).toHaveLength(2);
  for (const queue of queues) expect(queue.Properties.FifoQueue).toBe(true);
  dev.template.hasResourceProperties("AWS::SQS::Queue", {
    ContentBasedDeduplication: false,
    RedrivePolicy: { maxReceiveCount: 5 },
  });
});

test("the config bucket is private and refuses plain HTTP", () => {
  dev.template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  dev.template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: [
        Match.objectLike({
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
      ],
    },
  });
});

test("alarms on dead letters and on silent probes, to a TLS-only topic nobody is subscribed to in code", () => {
  dev.template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "galena-dev-alarms" });
  dev.template.resourceCountIs("AWS::SNS::Subscription", 0);
  dev.template.hasResourceProperties("AWS::SNS::TopicPolicy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
      ]),
    }),
  });
  const alarms = resources("AWS::CloudWatch::Alarm").map((a) => a.Properties);
  expect(
    alarms.map((a) => [a.MetricName, a.ComparisonOperator, a.TreatMissingData]).sort(),
  ).toEqual([
    ["ApproximateNumberOfMessagesVisible", "GreaterThanOrEqualToThreshold", "notBreaching"],
    ["NumberOfMessagesSent", "LessThanThreshold", "breaching"],
  ]);
  for (const alarm of alarms) {
    expect(alarm.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^Alarms/) }]);
  }
});

test("publishes the identifiers other stacks and the workers read", () => {
  const names = resources("AWS::SSM::Parameter").map((p) => p.Properties.Name);
  expect(names.sort()).toEqual(
    [
      "alarm-topic-arn",
      "check-results-queue-arn",
      "check-results-queue-url",
      "config-bucket",
      "database-cluster-arn",
      "database-secret-arn",
      "telemetry-table",
    ].map((name) => `/galena/dev/${name}`),
  );
});

const policies = (template: Template, type: string) =>
  Object.values(template.findResources(type)).map((r) => r.DeletionPolicy);

test("every stage keeps the database, guarded against deletion, with two weeks of backups", () => {
  for (const { template } of [dev, prod]) {
    expect(policies(template, "AWS::RDS::DBCluster")).toEqual(["Retain"]);
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
    });
  }
});

test("prod keeps telemetry and the config bucket when the stack goes; dev does not", () => {
  for (const type of ["AWS::DynamoDB::Table", "AWS::S3::Bucket"]) {
    expect(policies(prod.template, type)).toEqual(["Retain"]);
    expect(policies(dev.template, type)).toEqual(["Delete"]);
  }
});

test("passes cdk-nag AwsSolutions in both stages", () => {
  expect(() => dev.app.synth()).not.toThrow();
  expect(() => prod.app.synth()).not.toThrow();
});
