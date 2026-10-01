import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { ApiStack } from "../stacks/api.ts";
import { indexRewrite, WebStack } from "../stacks/web.ts";

const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const env = { region: "eu-central-1", account: "111111111111" };
const api = new ApiStack(app, "Api", { env, config: stages.dev });
// A one-page export, so the upload and its cdk-nag acknowledgements are always exercised.
const siteDir = mkdtempSync(join(tmpdir(), "galena-web-"));
writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>Galena</title>");
const web = new WebStack(app, "Web", { env, config: stages.dev, api: api.api, siteDir });
const template = Template.fromStack(web);
const distribution = () =>
  Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]?.Properties
    .DistributionConfig;

test("keeps the site bucket private and reads it through origin access control", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
});

test("serves the export over HTTPS with security headers and the index rewrite", () => {
  expect(distribution().DefaultCacheBehavior).toMatchObject({
    ViewerProtocolPolicy: "redirect-to-https",
    ResponseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03", // managed SecurityHeadersPolicy
    FunctionAssociations: [{ EventType: "viewer-request" }],
  });
});

test("forwards /auth/* and /v1/* to the API uncached, with every method", () => {
  const behaviors = distribution().CacheBehaviors as {
    PathPattern: string;
    AllowedMethods: string[];
    CachePolicyId: string;
  }[];
  expect(behaviors.map((b) => b.PathPattern).sort()).toEqual(["/auth/*", "/v1/*"]);
  for (const behavior of behaviors) {
    expect(behavior.AllowedMethods).toContain("POST");
    expect(behavior.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // CachingDisabled
  }
});

test("adds the origin secret to every request it forwards to the API", () => {
  const apiOrigin = distribution().Origins.find(
    (o: { CustomOriginConfig?: unknown }) => o.CustomOriginConfig,
  );
  expect(apiOrigin.OriginCustomHeaders).toEqual([
    {
      HeaderName: "x-galena-origin",
      HeaderValue: "{{resolve:secretsmanager:galena/dev/origin-secret:SecretString:::}}",
    },
  ]);
});

test("has no custom error pages that would hide the API's problem responses", () => {
  expect(distribution().CustomErrorResponses).toBeUndefined();
});

test("uploads the export and invalidates every cached path", () => {
  template.hasResourceProperties("Custom::CDKBucketDeployment", {
    DistributionPaths: ["/*"],
    Prune: true,
  });
});

test("publishes the dashboard URL for the API to read at cold start", () => {
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/galena/dev/public-url",
    Type: "String",
  });
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});

test.each([
  ["/", "/index.html"],
  ["/dashboard/", "/dashboard/index.html"],
  ["/dashboard", "/dashboard/index.html"],
  ["/dashboard/components/", "/dashboard/components/index.html"],
  ["/_next/static/chunks/app.js", "/_next/static/chunks/app.js"],
  ["/favicon.ico", "/favicon.ico"],
])("the index rewrite maps %s to %s", (uri, expected) => {
  const handler = new Function(`${indexRewrite}; return handler;`)();
  expect(handler({ request: { uri } }).uri).toBe(expected);
});
