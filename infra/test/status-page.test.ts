import { App, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { expect, test } from "vitest";
import { stages } from "../config/stages.ts";
import { PageCertificateStack, PageReplicaStack, StatusPageStack } from "../stacks/status-page.ts";

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const account = "111111111111";
const replica = new PageReplicaStack(app, "Replica", {
  env: { region: "eu-north-1", account },
  config: stages.dev,
});
const certificateStack = new PageCertificateStack(app, "Certificate", {
  env: { region: "us-east-1", account },
  domain: "status.astrl.me",
  crossRegionReferences: true,
});
const page = new StatusPageStack(app, "Page", {
  env: { region: "eu-west-1", account },
  config: stages.dev,
  certificate: certificateStack.certificate,
  apiEndpoint: "https://abc123.execute-api.eu-central-1.amazonaws.com",
  crossRegionReferences: true,
});
// Prod has no domain yet: the default CloudFront name.
const plain = new StatusPageStack(app, "PlainPage", {
  env: { region: "eu-west-1", account },
  config: stages.prod,
  apiEndpoint: "https://abc123.execute-api.eu-central-1.amazonaws.com",
});
const template = Template.fromStack(page);
const distribution = (t: Template) =>
  Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]?.Properties.DistributionConfig;

test("the replica is private and readable only by this account's CloudFront distributions", () => {
  const replicaTemplate = Template.fromStack(replica);
  replicaTemplate.hasResourceProperties("AWS::S3::Bucket", {
    BucketName: "galena-dev-page-replica-111111111111",
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: { BlockPublicPolicy: true, RestrictPublicBuckets: true },
  });
  const policy = JSON.stringify(replicaTemplate.findResources("AWS::S3::BucketPolicy"));
  expect(policy).toContain("cloudfront.amazonaws.com");
  expect(policy).toContain(":cloudfront::111111111111:distribution/*");
});

test("the primary bucket replicates every object to the replica", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    BucketName: "galena-dev-page-111111111111",
    VersioningConfiguration: { Status: "Enabled" },
  });
  const [bucket] = Object.values(template.findResources("AWS::S3::Bucket"));
  const rules = bucket?.Properties.ReplicationConfiguration.Rules;
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ Status: "Enabled", Filter: { Prefix: "" } });
  expect(JSON.stringify(rules[0].Destination)).toContain(
    ":s3:::galena-dev-page-replica-111111111111",
  );
});

test("CloudFront fails over from the primary to the replica on 403 and 5xx", () => {
  const config = distribution(template);
  const [group] = config.OriginGroups.Items;
  expect(group.FailoverCriteria.StatusCodes.Items).toEqual([403, 500, 502, 503, 504]);
  const buckets = config.Origins.filter((o: { S3OriginConfig?: unknown }) => o.S3OriginConfig);
  expect(group.Members.Items.map((m: { OriginId: string }) => m.OriginId)).toEqual(
    buckets.map((o: { Id: string }) => o.Id),
  );
  for (const origin of buckets) {
    expect(origin.OriginPath).toBe("/pages/status");
    expect(origin.OriginAccessControlId).toBeDefined();
  }
  expect(JSON.stringify(buckets[1].DomainName)).toContain(
    "galena-dev-page-replica-111111111111.s3.eu-north-1",
  );
  expect(config.CustomErrorResponses).toBeUndefined();
});

test("serves status.astrl.me over TLS 1.2+, with HSTS and no framing", () => {
  const config = distribution(template);
  expect(config.Aliases).toEqual(["status.astrl.me"]);
  expect(config.ViewerCertificate.MinimumProtocolVersion).toBe("TLSv1.2_2021");
  expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
  template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
    ResponseHeadersPolicyConfig: {
      SecurityHeadersConfig: {
        ContentSecurityPolicy: {
          ContentSecurityPolicy:
            "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
        },
        StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000 },
        FrameOptions: { FrameOption: "DENY" },
      },
    },
  });
  Template.fromStack(certificateStack).hasResourceProperties(
    "AWS::CertificateManager::Certificate",
    { DomainName: "status.astrl.me", ValidationMethod: "DNS" },
  );
});

test("without a domain the page uses CloudFront's own name", () => {
  expect(distribution(Template.fromStack(plain)).Aliases).toBeUndefined();
});

test("passes cdk-nag AwsSolutions", () => {
  expect(() => app.synth()).not.toThrow();
});

test("sends only the subscription forms to the API, uncached, with the visitor's address", () => {
  const config = distribution(template);
  const [forms] = config.CacheBehaviors;
  expect(config.CacheBehaviors).toHaveLength(1);
  expect(forms).toMatchObject({
    PathPattern: "/public/*",
    ViewerProtocolPolicy: "https-only",
    CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", // CachingDisabled
  });
  expect(forms.AllowedMethods).toContain("POST");
  expect(forms.FunctionAssociations).toBeUndefined();
  template.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
    OriginRequestPolicyConfig: {
      HeadersConfig: {
        HeaderBehavior: "whitelist",
        Headers: ["CloudFront-Viewer-Address", "Content-Type", "Accept"],
      },
      CookiesConfig: { CookieBehavior: "none" },
      QueryStringsConfig: { QueryStringBehavior: "all" },
    },
  });
  const apiOrigin = config.Origins.find(
    (o: { CustomOriginConfig?: unknown }) => o.CustomOriginConfig,
  );
  expect(apiOrigin.DomainName).toBe("abc123.execute-api.eu-central-1.amazonaws.com");
});
