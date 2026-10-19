import { integrationId, signalIdempotencyKey, signalSources } from "@galena/contracts";
import { readLinkToken } from "@galena/integrations/secrets";
import { readSignals } from "@galena/integrations/signals";
import { z } from "@hono/zod-openapi";
import { type App, type Deps, problemResponse } from "../http.ts";
import { createLimiter } from "../limiter.ts";

// Alerts from an integration's source. The URL's token is checked by its signature alone and
// each alert group handed to `signal.ingest`, never waiting on Postgres: Aurora can take 15 s to
// resume, and a source that times out sends again. Routes and policy are applied in the task.
// Known limit: a deleted integration's URL, or one a newer URL replaced, is refused only in the
// task, after it reads the integration; a source that keeps sending new alert groups there wakes
// Aurora for each. Store a revocation list in the config bucket if that ever matters.

const MAX_BODY_BYTES = 256 * 1024;
/** Alerts one integration may send an API instance a minute: a leaked URL can't flood the jobs. */
const ALERTS_PER_MINUTE = 120;
/** Triggers at a time for a generic list of up to 100 alerts. */
const BATCH = 10;

const unknownHook = () =>
  problemResponse({
    status: 404,
    code: "unknown_hook",
    title: "No such hook URL",
    detail: "Copy the URL again from the integration in the dashboard, or make a new one there.",
  });
const tooLarge = () =>
  problemResponse({
    status: 413,
    code: "body_too_large",
    title: "The alert is too large",
    detail: `Send at most ${MAX_BODY_BYTES / 1024} KB. For Alertmanager, set max_alerts on the webhook.`,
  });
const notAlerts = (source: string) =>
  problemResponse({
    status: 400,
    code: "bad_alert_body",
    title: "Not an alert this hook reads",
    detail:
      source === "alertmanager"
        ? "Send Alertmanager's webhook body (version 4)."
        : "Send { key, status, startsAt } with optional title and labels, or a list of them.",
  });

const tooMany = () => {
  const response = problemResponse({
    status: 429,
    code: "too_many_alerts",
    title: "Too many alerts",
    detail: `This hook takes at most ${ALERTS_PER_MINUTE} alerts a minute. Group alerts so fewer are sent, or try again in a minute.`,
  });
  response.headers.set("retry-after", "60");
  return response;
};

export function registerHookRoutes(app: App, deps: Deps) {
  const perIntegration = createLimiter({ max: ALERTS_PER_MINUTE, windowMs: 60_000 });
  app.post("/hooks/:source/:token", async (c) => {
    const source = z.enum(signalSources).safeParse(c.req.param("source"));
    const token = readLinkToken(deps.keys, "hook", c.req.param("token"));
    const id = integrationId.safeParse(token?.id);
    if (!source.success || !token || !id.success) return unknownHook();
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return tooLarge();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return notAlerts(source.data);
    }
    const signals = readSignals(source.data, body);
    if (!signals) return notAlerts(source.data);
    if (!perIntegration(id.data, signals.length)) return tooMany();

    const tokenIssuedAt = token.issuedAt.toISOString();
    for (let i = 0; i < signals.length; i += BATCH) {
      await Promise.all(
        signals.slice(i, i + BATCH).map((signal) => {
          const ingest = { integrationId: id.data, tokenIssuedAt, signal };
          return deps.engine.trigger("signal.ingest", ingest, {
            idempotencyKey: signalIdempotencyKey(ingest),
          });
        }),
      );
    }
    return c.json({ accepted: signals.length }, 202);
  });
}
