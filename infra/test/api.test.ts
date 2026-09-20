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
    Environment: { Variables: { GLN_STAGE: "dev" } },
  });
  for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
});

test("the handler's role can write its logs and nothing else", () => {
  for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  }
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  expect(statements.flatMap((s) => [s.Action].flat()).sort()).toEqual([
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]);
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
