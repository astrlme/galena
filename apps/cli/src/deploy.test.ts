import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import {
  deploy,
  dnsRecords,
  newSecret,
  retryable,
  secretsToMake,
  validationRecords,
} from "./deploy.ts";
import { buildConfig } from "./init.ts";

const config = buildConfig({ stage: "demo", preset: "eu" });

test("lets go of a terminal's input when it stops, so the process can exit", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  expect(await deploy(join(tmpdir(), "galena-no-such-config.json"), { input, output })).toBe(1);
  expect(input.listenerCount("data")).toBe(0);
});

test("new secrets are 32 random bytes: hex, or base64 for the app key", () => {
  expect(newSecret["auth-secret"]()).toMatch(/^[0-9a-f]{64}$/);
  expect(newSecret["setup-token"]()).toMatch(/^[0-9a-f]{64}$/);
  expect(Buffer.from(newSecret["app-key"](), "base64")).toHaveLength(32);
  expect(newSecret["auth-secret"]()).not.toBe(newSecret["auth-secret"]());
});

test("makes only missing secrets, and the setup token only before the first deploy", () => {
  expect(secretsToMake(config, new Set(), true)).toEqual(["auth-secret", "app-key", "setup-token"]);
  expect(secretsToMake(config, new Set(), false)).toEqual(["auth-secret", "app-key"]);
  expect(
    secretsToMake(config, new Set(["/galena/demo/auth-secret", "/galena/demo/setup-token"]), true),
  ).toEqual(["app-key"]);
});

test("names the validation CNAMEs of the config's own domains once ACM has them", () => {
  const record = (DomainName: string, Name?: string) => ({
    DomainName,
    ...(Name ? { ResourceRecord: { Name, Type: "CNAME" as const, Value: `${Name}acm.aws.` } } : {}),
  });
  expect(
    validationRecords(
      ["demo.example.com", "status.example.com"],
      [
        { DomainValidationOptions: [record("demo.example.com", "_a.demo.example.com.")] },
        { DomainValidationOptions: [record("status.example.com")] },
        { DomainValidationOptions: [record("other.example.com", "_c.other.example.com.")] },
        undefined,
      ],
    ),
  ).toEqual([
    {
      domain: "demo.example.com",
      name: "_a.demo.example.com.",
      value: "_a.demo.example.com.acm.aws.",
    },
  ]);
});

test("lists each domain's CNAME and the email stack's records, without arrows", () => {
  const deployment = buildConfig({
    stage: "demo",
    preset: "eu",
    pageDomain: "status.example.com",
    webDomain: "demo.example.com",
    emailDomain: "mail.example.com",
  });
  const stacks = new Map([
    ["galena-demo-page", { outputs: { DistributionDomain: "d1.cloudfront.net" } }],
    ["galena-demo-web", { outputs: { DistributionDomain: "d2.cloudfront.net" } }],
    [
      "galena-demo-email",
      {
        outputs: {
          DkimCname1: "a._domainkey.mail.example.com -> a.dkim.amazonses.com",
          MailFromMx: "bounce.mail.example.com -> 10 feedback-smtp.eu-central-1.amazonses.com",
        },
      },
    ],
  ]);
  expect(dnsRecords(deployment, stacks)).toEqual([
    "CNAME  status.example.com  d1.cloudfront.net",
    "CNAME  demo.example.com  d2.cloudfront.net",
    "CNAME  a._domainkey.mail.example.com  a.dkim.amazonses.com",
    "MX     bounce.mail.example.com  10 feedback-smtp.eu-central-1.amazonses.com",
  ]);
});

test("tries setup again only while the API or the database is starting", () => {
  expect([502, 503, 504].every(retryable)).toBe(true);
  expect([400, 403, 409, 422, 500].some(retryable)).toBe(false);
});
