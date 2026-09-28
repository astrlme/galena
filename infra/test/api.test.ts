import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { ApiStack } from "../stacks/api.ts";

// Skip esbuild here; `pnpm infra:synth` bundles for real.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const template = Template.fromStack(new ApiStack(app, "Api", { config: stages.dev }));

test("runs the API on Node 24 arm64 Lambda outside any VPC", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    Timeout: 29,
  });
  for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
});

test("the API and migration roles get logs, the Data API and their secrets, nothing more", () => {
  const roles = Object.entries(template.findResources("AWS::IAM::Role")).filter(([id]) =>
    /^(Handler|Migrate)Role/.test(id),
  );
  expect(roles).toHaveLength(2);
  for (const [, role] of roles) expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
    p.Properties.Roles.some((r: { Ref: string }) => /^(Handler|Migrate)Role/.test(r.Ref)),
  );
  const actions = new Set(
    policies.flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: unknown }) => [s.Action].flat()),
    ),
  );
  expect([...actions].sort()).toEqual([
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "secretsmanager:GetSecretValue",
    "ssm:GetParameter",
  ]);
});

test("the API reads its database from Foundation's parameters and its secrets from SSM", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 29,
    Environment: {
      Variables: {
        GLN_STAGE: "dev",
        GLN_DB_NAME: "galena",
        GLN_AUTH_SECRET_PARAM: "/galena/dev/auth-secret",
        GLN_TRIGGER_SECRET_PARAM: "/galena/dev/trigger-secret-key",
        GLN_PUBLIC_URL_PARAM: "/galena/dev/public-url",
      },
    },
  });
});

test("migrations run on deploy through a trigger with room for Aurora to resume", () => {
  template.resourceCountIs("Custom::Trigger", 1);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Handler: "index.handler",
    Timeout: 120,
  });
});

test("throttles the stage at 50 requests a second with bursts of 100, with access logs", () => {
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    AccessLogSettings: {},
  });
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
