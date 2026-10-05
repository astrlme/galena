import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { AbortTaskRunError, logger, queue, task } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { emailPayload, failEmail, localMailbox, sendEmail, sesMailer } from "../email.ts";
import { env } from "../env.ts";

// A few at a time: SES's send rate is 1 per second in the sandbox and 14 after that.
const email = queue({ name: "email", concurrencyLimit: 5 });

const keys = appKeys(env.GLN_APP_KEY ?? LOCAL_APP_KEY);
const mailer = env.GLN_EMAIL_FROM
  ? sesMailer({
      region: env.GLN_HOME_REGION,
      from: env.GLN_EMAIL_FROM,
      configurationSet: env.GLN_SES_CONFIGURATION_SET,
    })
  : localMailbox(env.GLN_MAIL_DIR, keys);

// SES refusing the message itself won't change on a retry; throttling and outages will.
const FINAL = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "BadRequestException",
]);

/** One email, keyed `send:{eventId}:{subscriberId}`: a confirmation or a notice. */
export const notifyEmail = task({
  id: "notify.email",
  queue: email,
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
  run: async (payload: unknown, { ctx }) => {
    const request = emailPayload.parse(payload);
    try {
      const outcome = await sendEmail(request, {
        db,
        keys,
        mailer,
        url: env.GLN_PAGE_URL,
        now: () => new Date(),
        attempt: ctx.attempt.number,
      });
      logger.info("notify.email", { kind: request.kind, outcome });
      return { outcome };
    } catch (error) {
      if (error instanceof Error && FINAL.has(error.name))
        throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
  onFailure: async ({ payload, error }) => {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await failEmail(emailPayload.parse(payload), reason, { db });
  },
});
