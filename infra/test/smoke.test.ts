import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { SmokeStack } from "../stacks/smoke.ts";

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const template = Template.fromStack(new SmokeStack(app, "Smoke", { config: stages.dev }));
const statementsOf = (rolePrefix: string) =>
  Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref.startsWith(rolePrefix)))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);

test("the target is a public Function URL on a Lambda outside any VPC", () => {
  template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
  });
  for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
    expect(fn.Properties.VpcConfig).toBeUndefined();
  }
});

test("only workflows on the deploy ref can assume the smoke role", () => {
  template.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "galena-dev-github-smoke",
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:astrlme@61922439/galena@1391246106:ref:refs/heads/main",
            },
          },
        }),
      ],
    },
  });
});

test("the smoke role may stop and restart the target and read telemetry, nothing more", () => {
  const statements = statementsOf("GitHubSmokeRole");
  const actions = statements.flatMap((s) => [s.Action].flat()).sort();
  expect(actions).toEqual([
    "dynamodb:GetItem",
    "dynamodb:Query",
    "lambda:DeleteFunctionConcurrency",
    "lambda:PutFunctionConcurrency",
    "s3:GetObject",
    "ssm:GetParameter",
  ]);
  for (const s of statements) expect(JSON.stringify(s.Resource)).not.toMatch(/"\*"|\/\*"/);
  const lambda = statements.find((s) =>
    [s.Action].flat().includes("lambda:PutFunctionConcurrency"),
  );
  expect(lambda.Resource).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^Target/), "Arn"] });
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
