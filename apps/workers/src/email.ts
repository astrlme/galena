import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  EXPIRY_THRESHOLDS,
  eventId,
  expiry,
  inviteId,
  memberId,
  notice as noticeSchema,
  subscriberId,
} from "@galena/contracts";
import { assertNever, daysLeft, inviteState } from "@galena/core";
import {
  claimDelivery,
  type Db,
  ensurePage,
  findDelivery,
  findInvite,
  findMemberEmail,
  findSubscriber,
  findWorkspaceName,
  settleDelivery,
} from "@galena/db";
import { confirmationEmail, expiryEmail, inviteEmail, noticeEmail } from "@galena/emails";
import { type AppKeys, inviteUrl, keyedHash, linkToken } from "@galena/integrations/secrets";
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

/** The warning a member gets when a certificate or domain crosses a threshold. */
export const expiryWarning = expiry.pick({ kind: true, name: true, issuer: true }).extend({
  expiresAt: z.iso.datetime(),
  threshold: z.literal(EXPIRY_THRESHOLDS),
});
export type ExpiryWarningPayload = z.infer<typeof expiryWarning>;

export const emailPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmation"), subscriberId, eventId }),
  z.object({ kind: z.literal("notice"), subscriberId, notice: noticeSchema }),
  // To a member, never a subscriber: no delivery row, keyed `send:{warningId}:{memberId}`.
  z.object({ kind: z.literal("expiry"), memberId, warning: expiryWarning }),
  // To someone invited to the team: the address is read from the invite when it's sent, so it
  // never rides in the queue. Keyed `send:invite:{inviteId}`.
  z.object({ kind: z.literal("invite"), inviteId }),
]);
export type EmailPayload = z.infer<typeof emailPayload>;
type SubscriberEmail = Extract<EmailPayload, { subscriberId: unknown }>;

export type EmailDeps = {
  db: Db;
  keys: AppKeys;
  mailer: Mailer;
  url: string;
  /** The dashboard's origin, which member emails link to. */
  dashboardUrl: string;
  now: () => Date;
  /** The task's attempt number, from 1: what the delivery is claimed for. */
  attempt: number;
};
export type EmailOutcome = "sent" | "skipped" | "already_settled";

const eventOf = (payload: SubscriberEmail) =>
  payload.kind === "notice" ? payload.notice.eventId : payload.eventId;

/**
 * The email's delivery row, claimed for this attempt. Undefined when an earlier run settled it
 * (sent or skipped) or another run is sending it right now, so it never goes out twice at once.
 * Known limit: if the send succeeds and recording it fails, the retry sends again; SES takes no
 * idempotency key.
 */
async function claim(payload: SubscriberEmail, deps: EmailDeps) {
  const delivery = await findDelivery(deps.db, eventOf(payload), {
    subscriberId: payload.subscriberId,
  });
  if (delivery?.status !== "pending") return undefined;
  if (!(await claimDelivery(deps.db, delivery.id, deps.attempt))) return undefined;
  return { id: delivery.id, attempts: deps.attempt };
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

/**
 * A certificate or domain expiry warning to one member. Known limit: no delivery row, so a send
 * that succeeds before the run fails is sent again on the retry; SES takes no idempotency key.
 */
async function sendExpiryWarning(
  payload: Extract<EmailPayload, { kind: "expiry" }>,
  deps: EmailDeps,
): Promise<EmailOutcome> {
  const [to, target] = await Promise.all([
    findMemberEmail(deps.db, payload.memberId),
    ensurePage(deps.db),
  ]);
  if (!to || !target) return "skipped";
  const { warning } = payload;
  const email = await expiryEmail(
    { ...warning, daysLeft: daysLeft(warning.expiresAt, deps.now()) },
    { page: { name: target.name, url: deps.url }, dashboardUrl: `${deps.dashboardUrl}/dashboard/` },
  );
  // Known limit: no `List-Unsubscribe`: members can't turn these warnings off yet; a setting
  // per member would let them, and the header would point at it.
  await deps.mailer.send({ to, fromName: target.name, headers: {}, ...email });
  return "sent";
}

/** An invite to the team, while it's still open; a used, revoked or expired one is skipped. */
async function sendInvite(
  payload: Extract<EmailPayload, { kind: "invite" }>,
  deps: EmailDeps,
): Promise<EmailOutcome> {
  const found = await findInvite(deps.db, payload.inviteId);
  if (!found || inviteState(found, deps.now()) !== "open") return "skipped";
  const [workspaceName, target] = await Promise.all([
    findWorkspaceName(deps.db, found.workspaceId),
    ensurePage(deps.db),
  ]);
  if (!target) return "skipped";
  const email = await inviteEmail(
    {
      workspaceName: workspaceName ?? target.name,
      inviterName: found.invitedBy,
      email: found.email,
      role: found.role,
      expiresAt: found.expiresAt.toISOString(),
      link: inviteUrl(deps.keys, deps.dashboardUrl, found.id, found.createdAt),
    },
    { name: target.name, url: deps.url },
  );
  // Known limit: no `List-Unsubscribe`: an invite is one email to one address, nothing to
  // unsubscribe from.
  await deps.mailer.send({ to: found.email, fromName: target.name, headers: {}, ...email });
  return "sent";
}

export async function sendEmail(payload: EmailPayload, deps: EmailDeps): Promise<EmailOutcome> {
  switch (payload.kind) {
    case "confirmation":
      return sendConfirmation(payload, deps);
    case "notice":
      return sendNotice(payload, deps);
    case "expiry":
      return sendExpiryWarning(payload, deps);
    case "invite":
      return sendInvite(payload, deps);
    default:
      return assertNever(payload);
  }
}

/** After the last retry: the email's delivery is marked failed, with the reason. */
export async function failEmail(payload: EmailPayload, error: string, deps: { db: Db }) {
  // A member's or an invitee's email has no delivery row.
  if (payload.kind === "expiry" || payload.kind === "invite") return;
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
