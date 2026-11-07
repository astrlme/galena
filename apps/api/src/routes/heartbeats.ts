import { checkIns, type MonitorId, monitorId, pingUrl } from "@galena/contracts";
import { monitorRepository } from "@galena/db";
import { linkToken, readLinkToken } from "@galena/integrations/secrets";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, fail, notFound, problemResponse, requireRole } from "../http.ts";
import { changeOf, commit, json, newTokenTime } from "./shared.ts";

// Heartbeat monitors' ping URLs. A check-in's token is checked by its signature alone and the
// time written to DynamoDB, never Postgres, so a stranger's request can't wake Aurora. The
// sweeper reads the newest check-in every minute.

/**
 * How long an instance answers a URL from memory instead of writing again: under the shortest
 * grace (a minute), so a check-in it skips is never the one that counts.
 */
const REMEMBER_MS = 30_000;
// Known limit: past this many URLs the memory starts over, so a flood of distinct URLs costs one
// write each again; only genuine URLs get that far, and the API Gateway throttle bounds them.
const MAX_REMEMBERED = 1_000;
/** Check-ins a heartbeat's page lists. */
const LISTED_CHECK_INS = 20;

/** A heartbeat's ping URL on the dashboard's address, as a job calls it. */
export const pingUrlOf = (deps: Pick<Deps, "keys" | "publicUrl">, id: MonitorId, issuedAt: Date) =>
  new URL(`/hb/${linkToken(deps.keys, "heartbeat", id, issuedAt)}`, deps.publicUrl).href;

const unknownUrl = () =>
  problemResponse({
    status: 404,
    code: "unknown_ping_url",
    title: "No such ping URL",
    detail:
      "A newer URL may have replaced this one. Make a new one from the monitor in the dashboard and use it in the job.",
  });

export function registerHeartbeatRoutes(app: App, deps: Deps) {
  const viewer = requireRole(deps, "viewer");
  const editor = requireRole(deps, "editor");
  const monitors = monitorRepository(deps.db);

  // A job that checks in many times a second still costs one write per 30 s per instance, and a
  // replaced URL, once refused, never costs another: its issue time can only fall further behind.
  // Known limit: a deleted monitor's URL keeps answering 200 and writing; nothing reads what it
  // writes, and its items expire. Refusing it would mean a lookup per check-in.
  const remembered = new Map<string, { at: number; ok: boolean }>();

  // HEAD is answered by the GET route.
  app.on(["GET", "POST"], "/hb/:token", async (c) => {
    const raw = c.req.param("token");
    const token = readLinkToken(deps.keys, "heartbeat", raw);
    const id = monitorId.safeParse(token?.id);
    if (!token || !id.success) return unknownUrl();

    const now = Date.now();
    const known = remembered.get(raw);
    if (known && (!known.ok || now - known.at < REMEMBER_MS)) {
      return known.ok ? c.text("OK") : unknownUrl();
    }
    const ok = await deps.telemetry.checkIn(id.data, token.issuedAt, new Date(now));
    if (remembered.size >= MAX_REMEMBERED) remembered.clear();
    remembered.set(raw, { at: now, ok });
    return ok ? c.text("OK") : unknownUrl();
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/monitors/{id}/ping-url",
      tags: ["Monitors"],
      summary: "Make a new ping URL for a heartbeat monitor",
      description:
        "Check-ins through the old URL stop counting within about a minute, and the old URL is refused once the new one checks in. The new URL is in this answer only.",
      middleware: [editor],
      request: { params: z.object({ id: monitorId }) },
      responses: { 200: json(pingUrl, "The new ping URL") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await monitors.findById(member.workspaceId, id)) ?? notFound("Monitor");
      if (!existing.heartbeat) {
        return fail({
          status: 422,
          code: "not_heartbeat",
          title: "Only heartbeat monitors have a ping URL",
          detail: "This monitor checks a URL itself; nothing needs to call it.",
        });
      }
      const issuedAt = newTokenTime(new Date(existing.heartbeat.tokenIssuedAt));
      const heartbeat = { ...existing.heartbeat, tokenIssuedAt: issuedAt.toISOString() };
      await commit(
        deps,
        changeOf(member, "monitor", "updated", [id], { pingUrl: "replaced" }),
        (tx) => monitorRepository(tx).save({ ...existing, heartbeat }),
      );
      return c.json({ url: pingUrlOf(deps, id, issuedAt) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors/{id}/check-ins",
      tags: ["Monitors"],
      summary: "A heartbeat monitor's recent check-ins",
      description: `Newest first, at most ${LISTED_CHECK_INS}, from the last 30 days. Empty for HTTP monitors.`,
      middleware: [viewer],
      request: { params: z.object({ id: monitorId }) },
      responses: { 200: json(checkIns, "Check-in times") },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing =
        (await monitors.findById(c.get("member").workspaceId, id)) ?? notFound("Monitor");
      const times = existing.heartbeat ? await deps.telemetry.checkIns(id, LISTED_CHECK_INS) : [];
      return c.json({ checkIns: times }, 200);
    },
  );
}
