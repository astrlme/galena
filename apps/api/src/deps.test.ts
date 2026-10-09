import { afterEach, expect, test, vi } from "vitest";
import { slackAppFrom } from "./deps.ts";

afterEach(() => vi.restoreAllMocks());

test("a Slack secret that isn't JSON turns Slack off and names the fields, not the value", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // What PowerShell passes to the AWS CLI once it strips the inner double quotes.
  const stripped = "{clientId:123.456,clientSecret:s3cr3t-client,signingSecret:s3cr3t-signing}";
  expect(slackAppFrom(stripped)).toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
  expect(String(log.mock.calls[0])).toContain("clientId, clientSecret and signingSecret");
  expect(String(log.mock.calls[0])).not.toContain("s3cr3t");
});

test("reads a complete Slack secret, and treats a missing one as Slack off", () => {
  const app = { clientId: "123.456", clientSecret: "client", signingSecret: "signing" };
  expect(slackAppFrom(JSON.stringify(app))).toEqual(app);
  expect(slackAppFrom(undefined)).toBeUndefined();
});
