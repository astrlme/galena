import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { EmailStack } from "../stacks/email.ts";

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const email = stages.dev.email;
if (!email) throw new Error("dev sends email");
const stack = new EmailStack(app, "Email", {
  env: { region: "eu-central-1", account: "111111111111" },
  config: { ...stages.dev, email },
});
const template = Template.fromStack(stack);

test("verifies mail.astrl.me with Easy DKIM and its own MAIL FROM", () => {
  template.hasResourceProperties("AWS::SES::EmailIdentity", {
    EmailIdentity: "mail.astrl.me",
    DkimAttributes: { SigningEnabled: true },
    DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
    MailFromAttributes: {
      MailFromDomain: "bounce.mail.astrl.me",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    },
  });
});

test("sends through a configuration set that suppresses bounces and complaints", () => {
  template.hasResourceProperties("AWS::SES::ConfigurationSet", {
    Name: "galena-dev",
    SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
  });
  const [identity] = Object.values(template.findResources("AWS::SES::EmailIdentity"));
  expect(identity?.Properties.ConfigurationSetAttributes).toBeDefined();
});

test("outputs every DNS record the domain needs", () => {
  const outputs = Object.keys(template.findOutputs("*"));
  expect(outputs).toEqual(
    expect.arrayContaining([
      "DkimCname1",
      "DkimCname2",
      "DkimCname3",
      "MailFromMx",
      "MailFromSpf",
      "Dmarc",
    ]),
  );
});

test("dev sends as status@mail.astrl.me, and a from address must be at the domain", () => {
  expect(email).toEqual({ domain: "mail.astrl.me", from: "status@mail.astrl.me" });
});

test("bounces and complaints reach a Lambda that can use the Data API and nothing else", () => {
  template.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
    EventDestination: { MatchingEventTypes: ["bounce", "complaint"], Enabled: true },
  });
  template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda" });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    Environment: { Variables: { GLN_STAGE: "dev", GLN_DB_NAME: "galena" } },
  });
  const actions = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .flatMap((s: { Action: string | string[] }) => [s.Action].flat())
    .filter((a: string) => !a.startsWith("logs:"));
  expect(actions.sort()).toEqual([
    "rds-data:BatchExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:ExecuteStatement",
    "rds-data:RollbackTransaction",
    "secretsmanager:GetSecretValue",
  ]);
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});
