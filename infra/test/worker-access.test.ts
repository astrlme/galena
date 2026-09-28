import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { WorkerAccessStack } from "../stacks/worker-access.ts";

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const stack = new WorkerAccessStack(app, "WorkerAccess", { config: stages.dev });
const template = Template.fromStack(stack);
const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
  (p) => p.Properties.PolicyDocument.Statement,
);

test("one user, no managed policies, no access key in the template", () => {
  template.resourceCountIs("AWS::IAM::User", 1);
  template.hasResourceProperties("AWS::IAM::User", { UserName: "galena-dev-worker-access" });
  template.resourceCountIs("AWS::IAM::AccessKey", 0);
  for (const user of Object.values(template.findResources("AWS::IAM::User"))) {
    expect(user.Properties.ManagedPolicyArns).toBeUndefined();
  }
});

test("the workers may use the Data API, read the database secret and write monitors.json", () => {
  const actions = statements.flatMap((s) => [s.Action].flat()).sort();
  expect(actions).toEqual([
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "s3:PutObject",
    "secretsmanager:GetSecretValue",
  ]);
  for (const s of statements) expect(JSON.stringify(s.Resource)).not.toMatch(/"\*"|\/\*/);
  const s3 = statements.find((s) => s.Action === "s3:PutObject");
  expect(JSON.stringify(s3.Resource)).toContain("/monitors.json");
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
