import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stageRegions, stageSchema, stages } from "../config/stages.ts";
import { CiAccessStack } from "../stacks/ci-access.ts";

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const stack = new CiAccessStack(app, "CiAccess", { config: stages.dev });
const template = Template.fromStack(stack);

test("only workflows on the repository's deploy ref can assume the deploy role", () => {
  template.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub": "repo:astrlme/galena:ref:refs/heads/main",
            },
          },
        }),
      ],
    },
  });
});

test("the deploy role can only assume the CDK bootstrap roles in the stage's regions", () => {
  const policies = Object.values(template.findResources("AWS::IAM::Policy"));
  const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatchObject({ Action: "sts:AssumeRole", Effect: "Allow" });
  expect(JSON.stringify(statements[0].Resource)).not.toContain("*");

  const granted = statements[0].Resource.map((arn: unknown) => {
    const [, role, region] =
      JSON.stringify(arn).match(/cdk-hnb659fds-([a-z-]+)-role-.*?-([a-z]{2}-[a-z]+-\d)"/) ?? [];
    return `${role} ${region}`;
  });
  const expected = stageRegions(stages.dev).flatMap((region) =>
    ["deploy", "file-publishing", "lookup"].map((role) => `${role} ${region}`),
  );
  expect(granted.sort()).toEqual(expected.sort());
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});

test("rejects a stage whose status page shares a region with the API", () => {
  const { dev } = stages;
  const sameAsHome = { ...dev, pageRegions: { ...dev.pageRegions, primary: dev.homeRegion } };
  expect(stageSchema.safeParse(sameAsHome).success).toBe(false);
  expect(stageSchema.safeParse(dev).success).toBe(true);
});
