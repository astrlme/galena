import { slackOAuthAccess, slackPosted, slackRevoked, slackUserInfo } from "@galena/contracts";
import { isRetryable, postJson } from "../channels/post.ts";
import type { Guard } from "../net/ssrf.ts";

/** A Slack call that failed; `code` is Slack's own (`invalid_auth`, `ratelimited`) or `http_<status>`. */
export class SlackApiError extends Error {
  override name = "SlackApiError";
  readonly method: string;
  readonly code: string;
  readonly retryable: boolean;
  constructor(method: string, code: string, retryable: boolean) {
    // Never the token or the request: only what Slack said.
    super(`Slack's ${method} answered ${code}.`);
    this.method = method;
    this.code = code;
    this.retryable = retryable;
  }
}

export type SlackMessage = { text: string; blocks: unknown[]; attachments?: unknown[] };

type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

export type SlackApiOptions = {
  guard: Guard;
  /** Tests point these at a local server. */
  apiBase?: string;
  responseOrigins?: readonly string[];
};

/** The few Slack Web API methods Galena uses, through the SSRF guard, each within 8 s. */
export function slackApi({
  guard,
  apiBase = "https://slack.com/api/",
  responseOrigins = ["https://hooks.slack.com"],
}: SlackApiOptions) {
  async function call<T>(
    method: string,
    schema: Schema<T>,
    params: Record<string, string>,
    token?: string,
  ): Promise<T> {
    const { status, body } = await postJson({
      url: `${apiBase}${method}`,
      body: new URLSearchParams(params).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      guard,
      readBody: true,
    });
    if (status !== 200) throw new SlackApiError(method, `http_${status}`, isRetryable(status));
    const answer = JSON.parse(body ?? "{}") as { ok?: boolean; error?: string };
    if (!answer.ok) {
      const code = answer.error ?? "unknown_error";
      throw new SlackApiError(method, code, code === "ratelimited" || code === "internal_error");
    }
    const parsed = schema.safeParse(answer);
    if (!parsed.success) throw new SlackApiError(method, "unexpected_answer", false);
    return parsed.data;
  }

  return {
    /** Trades the code from Slack's consent screen for the bot's token. */
    exchangeCode: (input: {
      clientId: string;
      clientSecret: string;
      code: string;
      redirectUri: string;
    }) =>
      call("oauth.v2.access", slackOAuthAccess, {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),

    postMessage: (token: string, channel: string, message: SlackMessage) =>
      call(
        "chat.postMessage",
        slackPosted,
        {
          channel,
          text: message.text,
          blocks: JSON.stringify(message.blocks),
          ...(message.attachments ? { attachments: JSON.stringify(message.attachments) } : {}),
          unfurl_links: "false",
        },
        token,
      ),

    /** The person's verified email, or undefined for a bot, a deactivated account or none. */
    async userEmail(token: string, userId: string): Promise<string | undefined> {
      const { user } = await call("users.info", slackUserInfo, { user: userId }, token);
      return user.deleted || user.is_bot ? undefined : user.profile.email?.toLowerCase();
    },

    /** Uninstalls: the token stops working at once. */
    revoke: (token: string) => call("auth.revoke", slackRevoked, {}, token),

    /** Answers through a request's `response_url`: valid for 30 minutes, at most 5 times. */
    async respond(
      responseUrl: string,
      message: SlackMessage & { replace_original?: boolean; response_type?: "ephemeral" },
    ): Promise<void> {
      const url = URL.parse(responseUrl);
      if (!url || !responseOrigins.includes(url.origin)) {
        throw new SlackApiError("response_url", "not_slack", false);
      }
      const { status } = await postJson({ url: url.href, body: JSON.stringify(message), guard });
      if (status !== 200) {
        throw new SlackApiError("response_url", `http_${status}`, isRetryable(status));
      }
    },
  };
}
export type SlackApi = ReturnType<typeof slackApi>;
