import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eventId, notice as noticeSchema, subscriberId } from "@galena/contracts";
import {
  claimDelivery,
  type Db,
  ensurePage,
  findDelivery,
  findSubscriber,
  settleDelivery,
} from "@galena/db";
import { confirmationEmail, noticeEmail } from "@galena/emails";
import { type AppKeys, keyedHash, linkToken } from "@galena/integrations/secrets";
import { z } from "zod";

export type OutgoingEmail = {
  to: string;
  /** Shown as "<name> status" in the From line. */
  fromName: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
};
export type Mailer = { send: (email: OutgoingEmail) => Promise<{ id: string }> };

export const emailPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmation"), subscriberId, eventId }),
  z.object({ kind: z.literal("notice"), subscriberId, notice: noticeSchema }),
]);
export type EmailPayload = z.infer<typeof emailPayload>;

export type EmailDeps = { db: Db; keys: AppKeys; mailer: Mailer; url: string; now: () => Date };
export type EmailOutcome = "sent" | "skipped" | "already_settled";

const eventOf = (payload: EmailPayload) =>
  payload.kind === "notice" ? payload.notice.eventId : payload.eventId;

/**
 * The email's delivery row, claimed for this attempt. Undefined when an earlier run settled it
 * (sent or skipped) or another run is sending it right now, so it never goes out twice at once.
 * Known limit: if the send succeeds and recording it fails, the retry sends again; SES takes no
 * idempotency key.
 */
async function claim(payload: EmailPayload, deps: EmailDeps) {
  const delivery = await findDelivery(deps.db, eventOf(payload), {
    subscriberId: payload.subscriberId,
  });
  if (delivery?.status !== "pending") return undefined;
  if (!(await claimDelivery(deps.db, delivery.id, delivery.attempts))) return undefined;
  return { id: delivery.id, attempts: delivery.attempts + 1 };
}

/** Double opt-in: sent only while the subscriber still waits for confirmation. */
async function sendConfirmation(
  payload: Extract<EmailPayload, { kind: "confirmation" }>,
  deps: EmailDeps,
) {
  const delivery = await claim(payload, deps);
  if (!delivery) return "already_settled";
  const id = payload.subscriberId;
  const [subscriber, target] = await Promise.all([
    findSubscriber(deps.db, id),
    ensurePage(deps.db),
  ]);
  if (subscriber?.state !== "pending_confirmation" || !target) {
    await settleDelivery(deps.db, delivery.id, { status: "skipped", attempts: delivery.attempts });
    return "skipped";
  }
  const token = linkToken(deps.keys, "confirm", id, deps.now());
  const email = await confirmationEmail({
    page: { name: target.name, url: deps.url },
    // The page's button confirms; a mail scanner opening the link does nothing.
    confirmUrl: `${deps.url}/subscription/confirm/?t=${encodeURIComponent(token)}`,
  });
  const { id: providerId } = await deps.mailer.send({
    to: subscriber.email,
    fromName: target.name,
    headers: {},
    ...email,
  });
  await settleDelivery(deps.db, delivery.id, {
    status: "sent",
    attempts: delivery.attempts,
    providerId,
    sentAt: deps.now(),
  });
  return "sent";
}

/** One notice to one subscriber, recorded on its delivery row. */
async function sendNotice(payload: Extract<EmailPayload, { kind: "notice" }>, deps: EmailDeps) {
  const delivery = await claim(payload, deps);
  if (!delivery) return "already_settled";
  const { subscriberId: id, notice } = payload;
  const { attempts } = delivery;
  const subscriber = await findSubscriber(deps.db, id);
  if (subscriber?.state !== "active") {
    await settleDelivery(deps.db, delivery.id, { status: "skipped", attempts });
    return "skipped";
  }
  const token = encodeURIComponent(linkToken(deps.keys, "unsubscribe", id, deps.now()));
  const email = await noticeEmail(notice, {
    unsubscribeUrl: `${deps.url}/subscription/unsubscribe/?t=${token}`,
  });
  const { id: providerId } = await deps.mailer.send({
    to: subscriber.email,
    fromName: notice.page.name,
    // RFC 8058: mail apps show an Unsubscribe button that posts here, no page visit needed.
    headers: {
      "List-Unsubscribe": `<${deps.url}/public/unsubscribe?t=${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    ...email,
  });
  await settleDelivery(deps.db, delivery.id, {
    status: "sent",
    attempts,
    providerId,
    sentAt: deps.now(),
  });
  return "sent";
}

export async function sendEmail(payload: EmailPayload, deps: EmailDeps): Promise<EmailOutcome> {
  return payload.kind === "confirmation"
    ? sendConfirmation(payload, deps)
    : sendNotice(payload, deps);
}

/** After the last retry: the email's delivery is marked failed, with the reason. */
export async function failEmail(payload: EmailPayload, error: string, deps: { db: Db }) {
  const delivery = await findDelivery(deps.db, eventOf(payload), {
    subscriberId: payload.subscriberId,
  });
  if (delivery?.status !== "pending") return;
  // Each attempt was counted when it claimed the delivery.
  await settleDelivery(deps.db, delivery.id, {
    status: "failed",
    attempts: delivery.attempts,
    lastError: error.slice(0, 500),
  });
}

/** `"Acme status" <status@…>`; a name outside ASCII goes as an RFC 2047 encoded word. */
export function fromLine(name: string, address: string): string {
  const display = `${name} status`;
  const encoded = /^[\x20-\x7e]*$/.test(display)
    ? `"${display.replace(/["\\]/g, "\\$&")}"`
    : `=?utf-8?B?${Buffer.from(display).toString("base64")}?=`;
  return `${encoded} <${address}>`;
}

/** AWS stages: SES through the configuration set that handles bounces and complaints. */
export function sesMailer(options: {
  region: string;
  from: string;
  configurationSet: string;
}): Mailer {
  const ses = new SESv2Client({ region: options.region });
  return {
    async send(email) {
      const result = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: fromLine(email.fromName, options.from),
          Destination: { ToAddresses: [email.to] },
          ConfigurationSetName: options.configurationSet,
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: email.html, Charset: "UTF-8" },
                Text: { Data: email.text, Charset: "UTF-8" },
              },
              Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        }),
      );
      return { id: result.MessageId ?? "unknown" };
    },
  };
}

/** Local development: each email as a file in `dir`, named by a hash of the recipient. */
export function localMailbox(dir: string, keys: AppKeys): Mailer {
  let count = 0;
  return {
    async send(email) {
      await mkdir(resolve(dir), { recursive: true });
      const id = `${Date.now()}-${++count}-${keyedHash(keys, email.to).slice(0, 8)}`;
      const headers = Object.entries({ To: email.to, Subject: email.subject, ...email.headers });
      await writeFile(
        resolve(dir, `${id}.txt`),
        `${headers.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${email.text}\n`,
      );
      await writeFile(resolve(dir, `${id}.html`), email.html);
      return { id };
    },
  };
}
