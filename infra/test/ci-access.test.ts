import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stageRegions, stageSchema } from "../config/stages.ts";
import { CiAccessStack } from "../stacks/ci-access.ts";
import { fixture } from "./fixture.ts";

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const github = fixture.github;
if (!github) throw new Error("The fixture deploys from GitHub.");
const stack = new CiAccessStack(app, "CiAccess", { config: { ...fixture, github } });
const template = Template.fromStack(stack);

const SUB = "token.actions.githubusercontent.com:sub";
const roles = Object.values(template.findResources("AWS::IAM::Role")).map((r) => r.Properties);
const roleNamed = (name: string) => roles.find((r) => r.RoleName === name);
const subjectsOf = (role: (typeof roles)[number]) => {
  const [statement, ...others] = role.AssumeRolePolicyDocument.Statement;
  expect(others).toEqual([]);
  expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
  expect(statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"]).toBe(
    "sts.amazonaws.com",
  );
  return [statement.Condition.StringEquals[SUB]].flat();
};
const policyOf = (role: string) => {
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(role))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatchObject({ Action: "sts:AssumeRole", Effect: "Allow" });
  expect(JSON.stringify(statements[0].Resource)).not.toContain("*");
  return [statements[0].Resource].flat().map((arn: unknown) => {
    const [, name, region] =
      JSON.stringify(arn).match(/cdk-hnb659fds-([a-z-]+)-role-.*?-([a-z]{2}-[a-z]+-\d)"/) ?? [];
    return `${name} ${region}`;
  });
};

test("only the deploy environment and the deploy ref can assume the deploy role", () => {
  expect(subjectsOf(roleNamed("galena-dev-github-deploy")).sort()).toEqual([
    "repo:example@1001/galena@2002:environment:deploy",
    "repo:example@1001/galena@2002:ref:refs/heads/main",
  ]);
});

test("the deploy role can only assume the CDK bootstrap roles in the stage's regions", () => {
  const expected = stageRegions(fixture).flatMap((region) =>
    ["deploy", "file-publishing", "lookup"].map((role) => `${role} ${region}`),
  );
  expect(policyOf("DeployRole").sort()).toEqual(expected.sort());
});

test("the lookup role, for the deploy ref, can only assume the home region's CDK lookup role", () => {
  expect(subjectsOf(roleNamed("galena-dev-github-lookup"))).toEqual([
    "repo:example@1001/galena@2002:ref:refs/heads/main",
  ]);
  expect(policyOf("LookupRole")).toEqual([`lookup ${fixture.homeRegion}`]);
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});

test("rejects a stage whose status page shares a region with the API", () => {
  const dev = fixture;
  const sameAsHome = { ...dev, pageRegions: { ...dev.pageRegions, primary: dev.homeRegion } };
  expect(stageSchema.safeParse(sameAsHome).success).toBe(false);
  expect(stageSchema.safeParse(dev).success).toBe(true);
});
