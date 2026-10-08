import type { Writable } from "node:stream";
import { loadConfig } from "@galena/infra/config";
import { readStacks } from "./aws.ts";
import { describeError } from "./doctor.ts";

/**
 * The Slack app for one deployment, as a manifest Slack's "From a manifest" accepts (JSON). The
 * scopes are the ones the API's /slack/install asks for.
 */
export function slackManifest(dashboardUrl: string) {
  const url = (path: string) => new URL(path, dashboardUrl).href;
  return {
    display_information: {
      name: "Galena",
      description: "Approve incident drafts and see what's open.",
    },
    features: {
      bot_user: { display_name: "Galena", always_online: false },
      slash_commands: [
        {
          command: "/incident",
          url: url("/slack/commands"),
          description: "List open incidents and drafts waiting for approval",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [url("/slack/oauth")],
      scopes: {
        bot: [
          "chat:write",
          "chat:write.public",
          "commands",
          "users:read",
          "users:read.email",
          "incoming-webhook",
        ],
      },
    },
    settings: {
      interactivity: { is_enabled: true, request_url: url("/slack/interactions") },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** `galena slack-manifest`: prints the manifest for the config's dashboard. */
export async function printSlackManifest(
  path: string,
  output: Writable = process.stdout,
): Promise<number> {
  try {
    const config = loadConfig(path);
    const dashboard = config.webDomain
      ? `https://${config.webDomain}`
      : (await readStacks(config)).get(`galena-${config.stage}-web`)?.outputs.DashboardUrl;
    if (!dashboard) {
      output.write(
        "Deploy first: the manifest needs the dashboard's address, which the web stack has.\n",
      );
      return 1;
    }
    output.write(`${JSON.stringify(slackManifest(dashboard), null, 2)}\n`);
    return 0;
  } catch (error) {
    output.write(`${describeError(error)}\n`);
    return 1;
  }
}
