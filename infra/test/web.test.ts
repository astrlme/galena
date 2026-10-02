import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { ApiStack } from "../stacks/api.ts";
import { CertificateStack } from "../stacks/status-page.ts";
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

test("serves the export over HTTPS with a CSP, HSTS and no framing, and the index rewrite", () => {
  expect(distribution().DefaultCacheBehavior).toMatchObject({
    ViewerProtocolPolicy: "redirect-to-https",
    ResponseHeadersPolicyId: { Ref: expect.stringMatching(/^Headers/) },
    FunctionAssociations: [{ EventType: "viewer-request" }],
  });
  const [policy] = Object.values(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
  const security = policy?.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
  expect(security.ContentSecurityPolicy.ContentSecurityPolicy).toContain("frame-ancestors 'none'");
  expect(security.ContentSecurityPolicy.ContentSecurityPolicy).toContain("default-src 'self'");
  expect(security.StrictTransportSecurity.AccessControlMaxAgeSec).toBe(31536000);
  expect(security.FrameOptions.FrameOption).toBe("DENY");
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

test("sends the API cookies, the query and only the headers it reads, with the visitor's address", () => {
  template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
    OriginRequestPolicyConfig: {
      HeadersConfig: {
        HeaderBehavior: "whitelist",
        Headers: [
          "CloudFront-Viewer-Address",
          "Origin",
          "Referer",
          "User-Agent",
          "Content-Type",
          "Accept",
        ],
      },
      CookiesConfig: { CookieBehavior: "all" },
      QueryStringsConfig: { QueryStringBehavior: "all" },
    },
  });
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

test("with a certificate, answers on the stage's domain over TLS 1.2 and publishes that URL", () => {
  const withDomain = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  Validations.of(withDomain).addPlugins(new AwsSolutionsChecks(withDomain));
  const { certificate } = new CertificateStack(withDomain, "Certificate", {
    env: { ...env, region: "us-east-1" },
    domain: "galena.example.com",
    crossRegionReferences: true,
  });
  const domainApi = new ApiStack(withDomain, "Api", { env, config: stages.dev });
  const stack = new WebStack(withDomain, "Web", {
    env,
    config: { ...stages.dev, webDomain: "galena.example.com" },
    api: domainApi.api,
    certificate,
    crossRegionReferences: true,
    siteDir,
  });
  const domainTemplate = Template.fromStack(stack);
  const config = Object.values(domainTemplate.findResources("AWS::CloudFront::Distribution"))[0]
    ?.Properties.DistributionConfig;
  expect(config.Aliases).toEqual(["galena.example.com"]);
  expect(config.ViewerCertificate.MinimumProtocolVersion).toBe("TLSv1.2_2021");
  domainTemplate.hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/galena/dev/public-url",
    Value: "https://galena.example.com",
  });
  expect(() => withDomain.synth()).not.toThrow();
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
