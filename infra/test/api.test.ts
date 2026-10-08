import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { ApiStack } from "../stacks/api.ts";
import { fixture } from "./fixture.ts";

// Skip esbuild here; `pnpm infra:synth` bundles for real.
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const template = Template.fromStack(new ApiStack(app, "Api", { config: fixture }));

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

test("the API and migration roles get logs, the Data API, their secrets and telemetry reads", () => {
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
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "secretsmanager:DescribeSecret",
    "secretsmanager:GetSecretValue",
    "ssm:GetParameter",
  ]);
});

test("generates the origin secret, copies it to the page region, and the API reads it via SSM", () => {
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "galena/dev/origin-secret",
    GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
    ReplicaRegions: [{ Region: fixture.pageRegions.primary }],
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 29,
    Environment: {
      Variables: {
        GLN_ORIGIN_SECRET_PARAM: "/aws/reference/secretsmanager/galena/dev/origin-secret",
      },
    },
  });
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
        GLN_APP_KEY_PARAM: "/galena/dev/app-key",
        GLN_SETUP_TOKEN_PARAM: "/galena/dev/setup-token",
        GLN_SLACK_APP_PARAM: "/galena/dev/slack-app",
        GLN_PUBLIC_URL_PARAM: "/galena/dev/public-url",
        GLN_PROBE_REGIONS: "eu-west-1,eu-west-3,eu-north-1",
        GLN_EMAIL_FROM: "status@mail.example.com",
      },
    },
  });
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  for (const name of ["auth-secret", "trigger-secret-key", "app-key", "setup-token", "slack-app"]) {
    expect(policies).toContain(`parameter/galena/dev/${name}`);
  }
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

test("only the API's own role reads telemetry, and it never writes it", () => {
  const statements: { roles: string[]; actions: string[] }[] = Object.values(
    template.findResources("AWS::IAM::Policy"),
  ).flatMap((p) =>
    p.Properties.PolicyDocument.Statement.map((s: { Action: string | string[] }) => ({
      roles: p.Properties.Roles.map((r: { Ref: string }) => r.Ref),
      actions: [s.Action].flat(),
    })),
  );
  const dynamo = statements.filter((s) => s.actions.some((a) => a.startsWith("dynamodb:")));
  expect(dynamo).toHaveLength(1);
  expect(dynamo[0]?.roles).toEqual([expect.stringMatching(/^HandlerRole/)]);
  expect(dynamo[0]?.actions.sort()).toEqual(["dynamodb:BatchGetItem", "dynamodb:Query"]);
});
