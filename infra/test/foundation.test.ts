import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, test } from "vitest";
import { checkSharedFreeTier, type StageConfig } from "../config/stages.ts";
import { FoundationStack } from "../stacks/foundation.ts";
import { fixture, plain } from "./fixture.ts";

function synth(config: StageConfig) {
  const app = new App();
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const stack = new FoundationStack(app, "Foundation", { config });
  return { app, template: Template.fromStack(stack) };
}

const dev = synth(fixture);
const prod = synth(plain);
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
      MaxCapacity: fixture.auroraMaxAcu,
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
  expect(() => checkSharedFreeTier([fixture, plain])).not.toThrow();
  const greedy = { ...plain, telemetryCapacity: { read: 21, write: 20 } };
  expect(() => checkSharedFreeTier([fixture, greedy])).toThrow(/read capacity adds up to 26/);
});

test("check results use a FIFO queue with a FIFO dead-letter queue", () => {
  const queues = resources("AWS::SQS::Queue");
  expect(queues).toHaveLength(6);
  for (const queue of queues) expect(queue.Properties.FifoQueue).toBe(true);
  dev.template.hasResourceProperties("AWS::SQS::Queue", {
    ContentBasedDeduplication: false,
    RedrivePolicy: { maxReceiveCount: 5 },
  });
});

test.each([
  ["Jobs", 720],
  ["Builds", 1800],
])(
  "%s run from a FIFO queue that dedupes by content, dead letters after five receives",
  (id, visibility) => {
    const queues = dev.template.findResources("AWS::SQS::Queue");
    const queue = Object.entries(queues).find(([key]) =>
      new RegExp(`^${id}[0-9A-F]{8}$`).test(key),
    );
    expect(queue?.[1].Properties).toMatchObject({
      FifoQueue: true,
      ContentBasedDeduplication: true,
      VisibilityTimeout: visibility,
      MessageRetentionPeriod: 14 * 24 * 3600,
      SqsManagedSseEnabled: true,
      RedrivePolicy: { maxReceiveCount: 5 },
    });
  },
);

test("Scheduler sends jobs for later into the jobs queue only, from this account only", () => {
  dev.template.hasResourceProperties("AWS::Scheduler::ScheduleGroup", { Name: "galena-dev-jobs" });
  dev.template.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Principal: { Service: "scheduler.amazonaws.com" },
          Condition: { StringEquals: { "aws:SourceAccount": Match.anyValue() } },
        }),
      ],
    },
  });
  const policies = resources("AWS::IAM::Policy").map((p) => p.Properties.PolicyDocument.Statement);
  expect(policies).toEqual([
    [
      {
        Effect: "Allow",
        Action: "sqs:SendMessage",
        Resource: { "Fn::GetAtt": [expect.stringMatching(/^Jobs[0-9A-F]{8}$/), "Arn"] },
      },
    ],
  ]);
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

test("alarms on dead letters, stuck jobs and silent probes, to a TLS-only topic nobody is subscribed to in code", () => {
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
    ["ApproximateAgeOfOldestMessage", "GreaterThanThreshold", "notBreaching"],
    ["ApproximateNumberOfMessagesVisible", "GreaterThanOrEqualToThreshold", "notBreaching"],
    ["ApproximateNumberOfMessagesVisible", "GreaterThanOrEqualToThreshold", "notBreaching"],
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
      "builds-dead-letter-arn",
      "builds-dead-letter-url",
      "builds-queue-arn",
      "builds-queue-url",
      "check-results-queue-arn",
      "check-results-queue-url",
      "config-bucket",
      "database-cluster-arn",
      "database-secret-arn",
      "job-scheduler-role-arn",
      "jobs-dead-letter-arn",
      "jobs-dead-letter-url",
      "jobs-queue-arn",
      "jobs-queue-url",
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

test("retainData keeps telemetry and the config bucket when the stack goes; without it they go", () => {
  for (const type of ["AWS::DynamoDB::Table", "AWS::S3::Bucket"]) {
    expect(policies(prod.template, type)).toEqual(["Retain"]);
    expect(policies(dev.template, type)).toEqual(["Delete"]);
  }
});

test("passes cdk-nag AwsSolutions in both deployments", () => {
  expect(() => dev.app.synth()).not.toThrow();
  expect(() => prod.app.synth()).not.toThrow();
});
