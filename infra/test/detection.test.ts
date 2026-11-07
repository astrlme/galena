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

test("alarms on evaluator errors and throttles, and on a sweeper failing or not running, to Foundation's alarm topic", () => {
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")).map(
    (a) => a.Properties,
  );
  expect(alarms.map((a) => [a.MetricName ?? "math", a.EvaluationPeriods]).sort()).toEqual([
    ["Errors", 2],
    ["Throttles", 1],
    ["math", 2],
  ]);
  const sweeper = alarms.find((a) => a.Metrics);
  expect(JSON.stringify(sweeper.Metrics)).toMatch(
    /FILL\(invocations, 0\) < 1 OR FILL\(errors, 0\) > 0/,
  );
  expect(sweeper.TreatMissingData).toBe("breaching");
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

/** The statements of the policies attached to the role whose logical id starts with `role`. */
function statementsOf(role: string) {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(`"${role}`))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}

test("the evaluator reaches telemetry, monitors.json, its queue, the jobs queue and its heartbeat URL, not Postgres or Scheduler", () => {
  const statements = statementsOf("EvaluatorRole");
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

test("the heartbeat sweeper runs the evaluator's code every minute, with the Scheduler's time", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Handler: "index.sweep",
    Timeout: 30,
    Environment: {
      Variables: Match.objectLike({ GLN_PROBE_REGIONS: "eu-west-1,eu-west-3,eu-north-1" }),
    },
  });
  const sweeper = Object.values(template.findResources("AWS::Lambda::Function")).find(
    (f) => f.Properties.Handler === "index.sweep",
  );
  expect(sweeper?.Properties.Environment.Variables.GLN_HEARTBEAT_PARAM).toBeUndefined();
  template.hasResourceProperties("AWS::Scheduler::Schedule", {
    ScheduleExpression: "cron(* * * * ? *)",
    Target: Match.objectLike({
      Input: Match.stringLikeRegexp("scheduled-time"),
      // No retries: the next minute judges every heartbeat afresh.
      RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0 },
    }),
  });
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 0 });
});

test("the Scheduler's role may invoke the sweeper and nothing else", () => {
  const invokes = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s: { Action: unknown }) => JSON.stringify(s.Action).includes("lambda:InvokeFunction"));
  expect(invokes).toHaveLength(1);
  expect(JSON.stringify(invokes[0].Resource)).toMatch(/HeartbeatSweeper/);
  expect(JSON.stringify(invokes[0].Resource)).not.toMatch(/Evaluator/);
});

test("the sweeper reaches telemetry, monitors.json and the jobs queue only", () => {
  const statements = statementsOf("SweeperRole");
  const actions = new Set(statements.flatMap((s) => [s.Action].flat()));
  expect([...actions].sort()).toEqual(
    [
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:GetObject",
      "sqs:SendMessage",
    ].sort(),
  );
  expect(JSON.stringify(statements)).not.toMatch(/rds-data|secretsmanager|scheduler|ssm:/);
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
