import { expect, test } from "vitest";
import { slackManifest } from "./slack.ts";

test("points every Slack request URL at the deployment's dashboard", () => {
  const manifest = slackManifest("https://dashboard.example.com");
  expect(manifest.oauth_config.redirect_urls).toEqual([
    "https://dashboard.example.com/slack/oauth",
  ]);
  expect(manifest.settings.interactivity.request_url).toBe(
    "https://dashboard.example.com/slack/interactions",
  );
  expect(manifest.features.slash_commands).toEqual([
    expect.objectContaining({
      command: "/incident",
      url: "https://dashboard.example.com/slack/commands",
    }),
  ]);
});

test("asks for exactly the scopes the app uses", () => {
  expect(slackManifest("https://d.example.com").oauth_config.scopes.bot).toEqual([
    "chat:write",
    "chat:write.public",
    "commands",
    "users:read",
    "users:read.email",
    "incoming-webhook",
  ]);
});
