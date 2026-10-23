import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { JobsStack } from "../stacks/jobs.ts";
import { fixture } from "./fixture.ts";

// Skip esbuild and the builder's packaging here; `pnpm infra:synth` builds both for real.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const stack = new JobsStack(app, "Jobs", {
  config: fixture,
  pageUrl: "https://status.example.com",
});
const template = Template.fromStack(stack);

const functions = Object.entries(template.findResources("AWS::Lambda::Function"));
const fn = (prefix: string) => {
  const found = functions.find(([id]) => id.startsWith(prefix));
  if (!found) throw new Error(`No function ${prefix}`);
  return { id: found[0], ...found[1].Properties };
};

test("runs the jobs and the builder on Node 24 arm64, sized for their work", () => {
  expect(fn("Jobs")).toMatchObject({
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    MemorySize: 512,
    Timeout: 120,
  });
  expect(fn("Builder")).toMatchObject({
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    Handler: "index.handler",
    MemorySize: 2048,
    Timeout: 300,
    EphemeralStorage: { Size: 1024 },
  });
});

test("each function reads its own FIFO queue one message at a time, reporting failures per message", () => {
  const mappings = Object.values(template.findResources("AWS::Lambda::EventSourceMapping")).map(
    (m) => m.Properties,
  );
  expect(
    mappings.map((m) => [
      JSON.stringify(m.EventSourceArn),
      m.BatchSize,
      m.ScalingConfig,
      m.FunctionResponseTypes,
    ]),
  ).toEqual([
    [
      expect.stringMatching(/jobsqueuearn/),
      1,
      { MaximumConcurrency: 10 },
      ["ReportBatchItemFailures"],
    ],
    [
      expect.stringMatching(/buildsqueuearn/),
      1,
      { MaximumConcurrency: 2 },
      ["ReportBatchItemFailures"],
    ],
  ]);
});

const variables = (name: string) => Object.keys(fn(name).Environment.Variables).sort();

test("the jobs function gets the workers' settings, its queues and Scheduler, never the app key itself", () => {
  expect(variables("Jobs")).toEqual([
    "GLN_APP_KEY_PARAM",
    "GLN_BUILDS_QUEUE_ARN",
    "GLN_BUILDS_QUEUE_URL",
    "GLN_CONFIG_BUCKET",
    "GLN_DASHBOARD_URL",
    "GLN_DB_CLUSTER_ARN",
    "GLN_DB_NAME",
    "GLN_DB_SECRET_ARN",
    "GLN_DEAD_LETTER_URL",
    "GLN_EMAIL_FROM",
    "GLN_HEARTBEAT_PARAM",
    "GLN_HOME_REGION",
    "GLN_JOBS_QUEUE_ARN",
    "GLN_JOBS_QUEUE_URL",
    "GLN_PAGE_BUCKET",
    "GLN_PAGE_REGION",
    "GLN_PAGE_URL",
    "GLN_QUEUE_URL",
    "GLN_SCHEDULER_ROLE_ARN",
    "GLN_SCHEDULE_DEAD_LETTER_ARN",
    "GLN_SCHEDULE_GROUP",
    "GLN_SES_CONFIGURATION_SET",
    "GLN_TELEMETRY_TABLE",
  ]);
  expect(fn("Jobs").Environment.Variables.GLN_PAGE_URL).toBe("https://status.example.com");
});

test("the builder gets only what a build reads: the database, the page bucket and its queue", () => {
  expect(variables("Builder")).toEqual([
    "GLN_DB_CLUSTER_ARN",
    "GLN_DB_NAME",
    "GLN_DB_SECRET_ARN",
    "GLN_DEAD_LETTER_URL",
    "GLN_HOME_REGION",
    "GLN_PAGE_BUCKET",
    "GLN_PAGE_REGION",
    "GLN_QUEUE_URL",
    "NODE_OPTIONS",
  ]);
});

const actionsOf = (rolePrefix: string) =>
  Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref.startsWith(rolePrefix)))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .flatMap((s: { Action: string | string[] }) => [s.Action].flat())
    .sort();

test("the jobs function may do what the jobs do, and no more", () => {
  expect([...new Set(actionsOf("JobsRole"))]).toEqual([
    "dynamodb:BatchGetItem",
    "iam:PassRole",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "s3:GetObject",
    "s3:ListBucket",
    "s3:PutObject",
    "scheduler:CreateSchedule",
    "secretsmanager:GetSecretValue",
    "ses:SendEmail",
    "sqs:ChangeMessageVisibility",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
    "sqs:GetQueueUrl",
    "sqs:ReceiveMessage",
    "sqs:SendMessage",
    "ssm:GetParameter",
  ]);
});

test("the jobs function reads the app key and its heartbeat URL, and no other parameter", () => {
  const parameters = Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref.startsWith("JobsRole")))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s: { Action: string }) => s.Action === "ssm:GetParameter")
    .flatMap((s: { Resource: unknown }) => [s.Resource].flat().map((r) => JSON.stringify(r)));
  expect(parameters).toHaveLength(2);
  expect(parameters[0]).toMatch(/:parameter\/galena\/dev\/app-key"/);
  expect(parameters[1]).toMatch(/:parameter\/galena\/dev\/jobs-heartbeat"/);
  expect(fn("Jobs").Environment.Variables.GLN_HEARTBEAT_PARAM).toBe("/galena/dev/jobs-heartbeat");
});

test("the builder may build and upload the page, and no more: no app key, email or Scheduler", () => {
  expect([...new Set(actionsOf("BuilderRole"))]).toEqual([
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "s3:GetObject",
    "s3:ListBucket",
    "s3:PutObject",
    "secretsmanager:GetSecretValue",
    "sqs:ChangeMessageVisibility",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes",
    "sqs:GetQueueUrl",
    "sqs:ReceiveMessage",
    "sqs:SendMessage",
  ]);
  const resources = JSON.stringify(
    Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
      p.Properties.Roles.some((r: { Ref: string }) => r.Ref.startsWith("BuilderRole")),
    ),
  );
  expect(resources).not.toMatch(/monitors\.json|published\.json|configbucket/);
});

test("the scheduled jobs run from Scheduler into the jobs queue, in their lanes, with the time they were due", () => {
  const schedules = Object.values(template.findResources("AWS::Scheduler::Schedule")).map(
    (r) => r.Properties,
  );
  const byJob = new Map(schedules.map((p) => [JSON.parse(p.Target.Input).job, p]));
  expect([...byJob.keys()].sort()).toEqual(["outbox.sweep", "page.heartbeat", "rollup.uptime"]);
  expect(byJob.get("page.heartbeat")).toMatchObject({
    GroupName: "galena-dev-jobs",
    ScheduleExpression: "cron(35 * * * ? *)",
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: {
      SqsParameters: { MessageGroupId: "publisher" },
      RetryPolicy: { MaximumEventAgeInSeconds: 3600 },
      DeadLetterConfig: { Arn: expect.anything() },
    },
  });
  expect(JSON.parse(byJob.get("outbox.sweep")?.Target.Input)).toEqual({
    job: "outbox.sweep",
    key: "cron:outbox.sweep:<aws.scheduler.scheduled-time>",
    payload: { timestamp: "<aws.scheduler.scheduled-time>" },
  });
  expect(byJob.get("rollup.uptime")?.ScheduleExpression).toBe("cron(5 0/6 * * ? *)");
});

test("the functions log to named groups, and two hours without a heartbeat alarm", () => {
  const names = Object.values(template.findResources("AWS::Logs::LogGroup")).map(
    (g) => g.Properties.LogGroupName,
  );
  expect(names.sort()).toEqual(["/galena/dev/builder", "/galena/dev/jobs"]);
  template.hasResourceProperties("AWS::Logs::MetricFilter", {
    FilterPattern: '{ $.message = "page.heartbeat" }',
    MetricTransformations: [
      { MetricNamespace: "Galena", MetricName: "heartbeat_runs", MetricValue: "1" },
    ],
  });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "heartbeat_runs",
    Period: 3600,
    EvaluationPeriods: 2,
    Threshold: 1,
    ComparisonOperator: "LessThanThreshold",
    TreatMissingData: "breaching",
  });
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
