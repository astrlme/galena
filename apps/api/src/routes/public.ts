import { componentId, eventId, type OutboxId, subscriberId } from "@galena/contracts";
import { confirmStep, subscribeStep, unsubscribeStep } from "@galena/core";
import {
  componentRepository,
  countConfirmationsSince,
  countSubscribersFromIp,
  ensurePage,
  findSubscriber,
  findSubscriberByEmail,
  recordChange,
  saveSubscriber,
  setSubscriberState,
} from "@galena/db";
import { keyedHash, readLinkToken } from "@galena/integrations/secrets";
import type { Context } from "hono";
import { v7 } from "uuid";
import { z } from "zod";
import { type App, type Deps, viewerAddress } from "../http.ts";
import { dispatch } from "./shared.ts";

// The status page's subscription forms, reached on the page's own origin (its CloudFront sends
// /public/* here). Plain HTML forms, so they work without JavaScript: form posts get a 303 to
// a static page; the page's script asks for JSON instead.

const PER_IP_PER_HOUR = 10;
/**
 * However many networks ask: past this, confirmations wait for the next hour, so the form can't
 * be used to make SES mail thousands of strangers and wreck the sending reputation.
 */
const CONFIRMATIONS_PER_HOUR = 200;
const page = (name: string) => `/subscription/${name}/`;

const subscribeForm = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  componentIds: z.array(componentId).max(100),
});

async function readForm(c: Context): Promise<Record<string, string | string[]>> {
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    return (await c.req.json().catch(() => ({}))) as Record<string, string | string[]>;
  }
  return (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
}
const list = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export function registerPublicRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;

  app.post("/public/subscribe", async (c) => {
    const json = (c.req.header("accept") ?? "").includes("application/json");
    const form = await readForm(c);
    const parsed = subscribeForm.safeParse({
      email: list(form.email)[0],
      componentIds: list(form.component ?? form.componentIds),
    });
    if (!parsed.success) {
      return json ? c.json({ status: "invalid_email" }, 400) : c.redirect(page("bad-address"), 303);
    }
    // Every outcome answers the same, so the form never tells whether an address is subscribed.
    const accepted = () =>
      json ? c.json({ status: "check_inbox" }, 202) : c.redirect(page("sent"), 303);
    const { email } = parsed.data;
    const now = new Date();
    const ipHash = keyedHash(keys, viewerAddress(c.req.raw.headers) ?? "direct");
    const target = await ensurePage(db);
    if (!target) return accepted();
    const ws = target.workspaceId;

    const hourAgo = new Date(now.getTime() - 3_600_000);
    if ((await countSubscribersFromIp(db, ipHash, hourAgo)) >= PER_IP_PER_HOUR) {
      console.warn("public.subscribe limited", { ip: ipHash });
      return accepted();
    }
    if ((await countConfirmationsSince(db, ws, hourAgo)) >= CONFIRMATIONS_PER_HOUR) {
      console.warn("public.subscribe capped", { perHour: CONFIRMATIONS_PER_HOUR });
      return accepted();
    }
    const known = new Set((await componentRepository(db).listByWorkspace(ws)).map((x) => x.id));
    const outboxId = await db.transaction(async (tx): Promise<OutboxId | undefined> => {
      const current = await findSubscriberByEmail(tx, ws, email);
      const step = subscribeStep(current, now);
      const id = current?.id ?? subscriberId.parse(v7());
      const renewing = step.state === "pending_confirmation";
      await saveSubscriber(tx, {
        id,
        workspaceId: ws,
        email,
        state: step.state,
        // A confirmed subscriber's choice changes only by subscribing again.
        componentIds: renewing
          ? parsed.data.componentIds.filter((x) => known.has(x))
          : (current?.componentIds ?? []),
        confirmSentAt: step.sendConfirmation ? now : (current?.confirmSentAt ?? null),
        ipHash,
      });
      if (!step.sendConfirmation) return undefined;
      return recordChange(tx, {
        workspaceId: ws,
        actorUserId: null,
        action: "subscriber.requested",
        targetType: "subscriber",
        targetId: id,
        event: {
          id: eventId.parse(v7()),
          type: "subscriber.requested",
          occurredAt: now.toISOString(),
          workspaceId: ws,
          data: { subscriberId: id },
        },
      });
    });
    if (outboxId) await dispatch(deps, outboxId);
    console.info("public.subscribe", { address: keyedHash(keys, email), confirming: !!outboxId });
    return accepted();
  });

  // Emails link to the static confirm page, whose button posts here: mail scanners follow links
  // but don't press buttons, so nobody is subscribed by a scanner. Older emails linked here.
  app.get("/public/confirm", (c) =>
    c.redirect(`${page("confirm")}?t=${encodeURIComponent(c.req.query("t") ?? "")}`, 303),
  );

  app.post("/public/confirm", async (c) => {
    const form = await readForm(c);
    const token = readLinkToken(keys, "confirm", list(form.t)[0] ?? "");
    const id = subscriberId.safeParse(token?.id);
    const current = token && id.success ? await findSubscriber(db, id.data) : undefined;
    const step = current && token ? confirmStep(current, token.issuedAt, new Date()) : undefined;
    if (!current || !step?.ok) return c.redirect(page("bad-link"), 303);
    if (current.state !== "active") await setSubscriberState(db, current.id, "active", new Date());
    console.info("public.confirm", { address: keyedHash(keys, current.email) });
    return c.redirect(page("confirmed"), 303);
  });

  // The unsubscribe page's form, and RFC 8058 one-click posts from mail apps
  // (`List-Unsubscribe=One-Click` to the URL in the List-Unsubscribe header).
  app.post("/public/unsubscribe", async (c) => {
    const form = await readForm(c);
    const oneClick = list(form["List-Unsubscribe"])[0] === "One-Click";
    const token = readLinkToken(keys, "unsubscribe", c.req.query("t") ?? list(form.t)[0] ?? "");
    const id = subscriberId.safeParse(token?.id);
    const current = id.success ? await findSubscriber(db, id.data) : undefined;
    if (!current) return oneClick ? c.body(null, 400) : c.redirect(page("bad-link"), 303);
    await setSubscriberState(db, current.id, unsubscribeStep(current.state));
    console.info("public.unsubscribe", { address: keyedHash(keys, current.email), oneClick });
    return oneClick ? c.body(null, 200) : c.redirect(page("unsubscribed"), 303);
  });
}
