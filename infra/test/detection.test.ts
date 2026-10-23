import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { DetectionStack } from "../stacks/detection.ts";
import { fixture } from "./fixture.ts";

// Skip esbuild here; `pnpm infra:synth` bundles for real.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const template = Template.fromStack(new DetectionStack(app, "Detection", { config: fixture }));

test("alarms on evaluator errors and throttles, to Foundation's alarm topic", () => {
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).map(
    (a) => a.Properties,
  );
  expect(alarms.map((a) => [a.MetricName, a.EvaluationPeriods]).sort()).toEqual([
    ["Errors", 2],
    ["Throttles", 1],
  ]);
  for (const alarm of alarms) {
    expect(JSON.stringify(alarm.AlarmActions)).toMatch(/SsmParameterValuegalenadevalarmtopicarn/);
  }
});

test("runs the evaluator on Node 24 arm64 Lambda outside any VPC", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    Timeout: 30,
    Environment: {
      Variables: {
        GLN_PROBE_REGIONS: "eu-west-1,eu-west-3,eu-north-1",
        GLN_SCHEDULE_GROUP: "galena-dev-jobs",
      },
    },
  });
  for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
});

test("consumes the queue 10 at a time and reports failed messages one by one", () => {
  template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    BatchSize: 10,
    FunctionResponseTypes: ["ReportBatchItemFailures"],
  });
});

test("the evaluator reaches telemetry, monitors.json, its queue, the jobs queue and its heartbeat URL, not Postgres or Scheduler", () => {
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  const actions = statements.flatMap((s) => [s.Action].flat()).sort();
  expect(actions).toEqual([
    "dynamodb:BatchGetItem",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "s3:GetObject",
    "sqs:ChangeMessageVisibility",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
    "sqs:GetQueueUrl",
    "sqs:ReceiveMessage",
    "sqs:SendMessage",
    "ssm:GetParameter",
  ]);
  expect(JSON.stringify(statements)).not.toMatch(/rds-data|secretsmanager|scheduler/);
  // One parameter, and not the app key or any other secret of the deployment.
  const parameters = statements
    .filter((s) => s.Action === "ssm:GetParameter")
    .flatMap((s) => [s.Resource].flat().map((r) => JSON.stringify(r)));
  expect(parameters).toHaveLength(1);
  expect(parameters[0]).toMatch(/:parameter\/galena\/dev\/evaluator-heartbeat"/);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({ GLN_HEARTBEAT_PARAM: "/galena/dev/evaluator-heartbeat" }),
    },
  });
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
