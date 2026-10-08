import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createGuard } from "../net/ssrf.ts";
import { SlackApiError, slackApi } from "./api.ts";

// A stand-in for slack.com/api and hooks.slack.com on loopback.
const requests: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const answers: Record<string, [number, unknown]> = {
  "/api/oauth.v2.access": [
    200,
    {
      ok: true,
      access_token: "xoxb-1-2-abc",
      bot_user_id: "U0BOT",
      team: { id: "T0ACME", name: "Acme" },
      incoming_webhook: { channel: "#incidents", channel_id: "C0INC", url: "https://hooks" },
    },
  ],
  "/api/chat.postMessage": [200, { ok: true, channel: "C0INC", ts: "1728390000.000100" }],
  "/api/users.info": [200, { ok: true, user: { profile: { email: "Ada@Example.com" } } }],
  "/api/auth.revoke": [200, { ok: true, revoked: true }],
  "/api/busy.method": [200, { ok: false, error: "ratelimited" }],
  "/api/wrong.token": [200, { ok: false, error: "invalid_auth" }],
  "/api/down.method": [503, {}],
  "/respond": [200, "ok"],
  "/expired": [404, "expired_url"],
};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    requests.push({ url: req.url ?? "", headers: req.headers, body });
    const [status, answer] = answers[req.url ?? ""] ?? [404, {}];
    res.statusCode = status;
    res.end(typeof answer === "string" ? answer : JSON.stringify(answer));
  });
});
let origin = "";
let api: ReturnType<typeof slackApi>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = slackApi({
    guard: createGuard({ allowAddresses: ["127.0.0.1"] }),
    apiBase: `${origin}/api/`,
    responseOrigins: [origin],
  });
});
afterAll(() => {
  server.close();
});

const last = () => requests.at(-1);
const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

test("trades an install code for the bot token, its team and the picked channel", async () => {
  const access = await api.exchangeCode({
    clientId: "1.2",
    clientSecret: "shh",
    code: "c0de",
    redirectUri: "https://dashboard.example.com/slack/oauth",
  });
  expect(access).toMatchObject({
    access_token: "xoxb-1-2-abc",
    team: { id: "T0ACME", name: "Acme" },
    incoming_webhook: { channel_id: "C0INC" },
  });
  expect(form(last()?.body ?? "")).toEqual({
    client_id: "1.2",
    client_secret: "shh",
    code: "c0de",
    redirect_uri: "https://dashboard.example.com/slack/oauth",
  });
});

test("posts a message with the bot's token and the blocks as JSON", async () => {
  const posted = await api.postMessage("xoxb-1-2-abc", "C0INC", {
    text: "A draft waits",
    blocks: [{ type: "section" }],
  });
  expect(posted).toEqual({ channel: "C0INC", ts: "1728390000.000100" });
  expect(last()?.headers.authorization).toBe("Bearer xoxb-1-2-abc");
  expect(JSON.parse(form(last()?.body ?? "").blocks ?? "")).toEqual([{ type: "section" }]);
});

test("reads a person's email in lower case", async () => {
  expect(await api.userEmail("xoxb-1-2-abc", "U0ADA")).toBe("ada@example.com");
});

test("says which failures are worth a retry, and never repeats the token", async () => {
  const failure = (method: string) =>
    api.postMessage("xoxb-secret", method, { text: "", blocks: [] }).catch((e: unknown) => e);
  answers["/api/chat.postMessage"] = [200, { ok: false, error: "ratelimited" }];
  const limited = await failure("C0");
  expect(limited).toBeInstanceOf(SlackApiError);
  expect(limited).toMatchObject({ code: "ratelimited", retryable: true });
  answers["/api/chat.postMessage"] = [200, { ok: false, error: "channel_not_found" }];
  expect(await failure("C0")).toMatchObject({ code: "channel_not_found", retryable: false });
  answers["/api/chat.postMessage"] = [503, {}];
  const down = await failure("C0");
  expect(down).toMatchObject({ code: "http_503", retryable: true });
  expect(String((down as Error).message)).not.toContain("xoxb-secret");
});

test("answers through a response URL, and refuses one that isn't Slack's", async () => {
  await api.respond(`${origin}/respond`, { text: "Published", blocks: [], replace_original: true });
  expect(JSON.parse(last()?.body ?? "")).toMatchObject({
    text: "Published",
    replace_original: true,
  });
  await expect(api.respond(`${origin}/expired`, { text: "", blocks: [] })).rejects.toMatchObject({
    code: "http_404",
    retryable: false,
  });
  await expect(
    api.respond("https://example.com/hooks", { text: "", blocks: [] }),
  ).rejects.toMatchObject({ code: "not_slack" });
});
