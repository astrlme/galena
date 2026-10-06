import { expect, test } from "vitest";
import { newSecret, secretsToMake, validationRecords } from "./deploy.ts";
import { buildConfig } from "./init.ts";

const config = buildConfig({ stage: "demo", preset: "eu" });

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
