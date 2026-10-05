import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { FoundationStack } from "../stacks/foundation.ts";
import { ProbeStack } from "../stacks/probe.ts";
import { fixture } from "./fixture.ts";

// Skip esbuild here; `pnpm infra:synth` bundles for real.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const config = fixture;
const foundation = new FoundationStack(app, "Foundation", {
  env: { region: config.homeRegion },
  config,
  crossRegionReferences: true,
});
const stack = new ProbeStack(app, "Probe", {
  env: { region: "eu-west-1" },
  config,
  configBucket: foundation.config,
  queue: foundation.checkResults,
  crossRegionReferences: true,
});
const template = Template.fromStack(stack);
const statementsOf = (rolePrefix: string) =>
  Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref.startsWith(rolePrefix)))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);

test("runs the probe on Node 24 arm64 Lambda outside any VPC, within 50 s", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    MemorySize: 256,
    Timeout: 50,
    Environment: { Variables: { GLN_HOME_REGION: "eu-central-1" } },
  });
  for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
});

test("the probe may write its logs, read monitors.json and send to the queue, nothing more", () => {
  const statements = statementsOf("ProbeRole");
  const actions = statements.flatMap((s) => [s.Action].flat()).sort();
  expect(actions).toEqual([
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "s3:GetObject",
    "sqs:SendMessage",
  ]);
  const s3 = statements.find((s) => s.Action === "s3:GetObject");
  expect(JSON.stringify(s3.Resource)).toContain("/monitors.json");
  expect(JSON.stringify(statements)).not.toMatch(/rds-data|dynamodb|ssm:|secretsmanager/);
});

test("the Scheduler runs it every minute and passes the scheduled time", () => {
  template.hasResourceProperties("AWS::Scheduler::Schedule", {
    ScheduleExpression: "cron(* * * * ? *)",
    Target: { Input: '{"scheduledAt":"<aws.scheduler.scheduled-time>"}' },
  });
  const actions = statementsOf("SchedulerRole").flatMap((s) => [s.Action].flat());
  expect(actions).toEqual(["lambda:InvokeFunction"]);
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
