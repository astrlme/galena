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

test("the workers may use the Data API, the database secret, monitors.json and the page files", () => {
  const actions = statements.flatMap((s) => [s.Action].flat()).sort();
  expect(actions).toEqual([
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "s3:GetObject",
    "s3:ListBucket",
    "s3:PutObject",
    "s3:PutObject",
    "secretsmanager:GetSecretValue",
    "ses:SendEmail",
  ]);
  const s3 = statements.find((s) => s.Action === "s3:PutObject");
  expect(JSON.stringify(s3.Resource)).toContain("/monitors.json");
});

test("page files are the only wildcard, and only under pages/ in the page bucket", () => {
  const page = statements.find((s) => [s.Action].flat().includes("s3:GetObject"));
  expect(JSON.stringify(page.Resource)).toMatch(/galena-dev-page-.*\/pages\/\*"/);
  for (const s of statements.filter((s) => s !== page)) {
    expect(JSON.stringify(s.Resource)).not.toMatch(/"\*"|\/\*/);
  }
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});

test("the workers send email only as the stage's identity, through its configuration set", () => {
  const ses = statements.find((s) => s.Action === "ses:SendEmail");
  const resources = JSON.stringify(ses.Resource);
  expect(resources).toContain(":identity/mail.astrl.me");
  expect(resources).toContain(":configuration-set/galena-dev");
  expect(ses.Resource).toHaveLength(2);
});
