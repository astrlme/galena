import { appKeys } from "@galena/integrations/secrets";
import { db } from "../db.ts";
import { emailPayload, failEmail, localMailbox, sendEmail, sesMailer } from "../email.ts";
import { appKey, env } from "../env.ts";
import { log } from "../log.ts";
import { defineJob, FinalError } from "../runner.ts";

const keys = appKeys(appKey());
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
export const notifyEmailJob = defineJob({
  name: "notify.email",
  payload: emailPayload,
  retry: { attempts: 5, factor: 2, minMs: 2_000, maxMs: 60_000 },
  run: async (request, { attempt }) => {
    try {
      const outcome = await sendEmail(request, {
        db,
        keys,
        mailer,
        url: env.GLN_PAGE_URL,
        now: () => new Date(),
        attempt,
      });
      log.info("notify.email", { kind: request.kind, outcome });
      return { outcome };
    } catch (error) {
      if (error instanceof Error && FINAL.has(error.name)) throw new FinalError(error.message);
      throw error;
    }
  },
  onFailure: async (request, error) => {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await failEmail(request, reason, { db });
  },
});
