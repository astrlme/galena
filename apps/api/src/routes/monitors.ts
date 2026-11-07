import {
  awsRegion,
  heartbeatDetection,
  type MonitorConfig,
  type MonitorInput,
  monitorCreated,
  monitorId,
  monitorInput,
  monitorsEnabledInput,
  monitorTelemetry,
  monitorView,
} from "@galena/contracts";
import { lastCheckIn, monitorStatus } from "@galena/core";
import { componentRepository, monitorRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import { RECENT_MINUTES } from "../telemetry.ts";
import { pingUrlOf } from "./heartbeats.ts";
import {
  assertUnderCap,
  CAPS,
  changeOf,
  commit,
  json,
  jsonBody,
  newTokenTime,
  noContent,
} from "./shared.ts";

const toView = ({ workspaceId: _, ...view }: MonitorConfig) => view;

/**
 * The settings as stored. A heartbeat keeps its ping URL's issue time across edits and always has
 * the heartbeat detection settings: there are no regions to tune.
 */
function toStored(input: MonitorInput, existing?: MonitorConfig) {
  if (!input.heartbeat) return { ...input, heartbeat: null };
  const tokenIssuedAt = existing?.heartbeat?.tokenIssuedAt ?? newTokenTime().toISOString();
  return {
    ...input,
    detection: heartbeatDetection,
    heartbeat: { ...input.heartbeat, tokenIssuedAt },
  };
}

export function registerMonitorRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const viewer = requireRole(deps, "viewer");
  const editor = requireRole(deps, "editor");
  const monitors = monitorRepository(db);
  const components = componentRepository(db);

  /** What the schema can't know: the component exists here, and the URL is one we'd check. */
  async function validate(member: Member, input: MonitorInput) {
    if (
      input.componentId !== null &&
      !(await components.findById(member.workspaceId, input.componentId))
    ) {
      fail({
        status: 422,
        code: "component_not_found",
        title: "That component does not exist",
        detail: "Pick a component from the list, or leave the monitor without one.",
      });
    }
    if (!input.http) return;
    // Names are resolved again at check time; this catches literal addresses early.
    const url = deps.targets.checkUrl(input.http.url);
    if (!url.ok) {
      fail({
        status: 422,
        code: "url_refused",
        title: "Couldn't save the monitor",
        detail: `${url.error.message} Use the public address people reach the service on.`,
      });
    }
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors",
      tags: ["Monitors"],
      summary: "Monitors, oldest first",
      middleware: [viewer],
      responses: { 200: json(z.object({ monitors: z.array(monitorView) }), "Every monitor") },
    }),
    async (c) => {
      const list = await monitors.listByWorkspace(c.get("member").workspaceId);
      return c.json({ monitors: list.map(toView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors/telemetry",
      tags: ["Monitors"],
      summary: "Each monitor's state, its newest results and its last day and month",
      description:
        "Reads telemetry only; poll it while the monitors page is open. `minutes` limits the results to that many of the newest scheduled minutes (60 by default). The summary is rolled up hourly, at five past.",
      middleware: [viewer],
      request: {
        query: z.object({
          minutes: z.coerce.number().int().min(1).max(RECENT_MINUTES).default(RECENT_MINUTES),
        }),
      },
      responses: {
        200: json(
          z.object({ regions: z.array(awsRegion), monitors: z.array(monitorTelemetry) }),
          "One entry per monitor, oldest monitor first",
        ),
      },
    }),
    async (c) => {
      const list = await monitors.listByWorkspace(c.get("member").workspaceId);
      const { minutes } = c.req.valid("query");
      const readings = await deps.telemetry.read(
        list.map((m) => m.id),
        minutes,
        list.filter((m) => m.type === "heartbeat").map((m) => m.id),
      );
      const telemetry = list.map((monitor) => {
        const reading = readings.get(monitor.id);
        const state = reading?.state ?? "unknown";
        return {
          id: monitor.id,
          state,
          status: monitorStatus(state, monitor.downStatus) ?? null,
          since: reading?.enteredAt ? new Date(reading.enteredAt).toISOString() : null,
          results: reading?.results ?? [],
          summary: reading?.summary ?? null,
          // The check-in the sweeper counts, so the page's due time agrees with it.
          lastPingAt:
            reading?.ping && monitor.heartbeat
              ? new Date(lastCheckIn(monitor.heartbeat, reading.ping)).toISOString()
              : null,
        };
      });
      return c.json({ regions: [...deps.telemetry.regions], monitors: telemetry }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/monitors",
      tags: ["Monitors"],
      summary: "Add a monitor; probes pick it up with the next config publish",
      description:
        "A heartbeat monitor's ping URL is in this answer only; `POST /v1/monitors/{id}/ping-url` makes a new one. Heartbeat monitors always use fixed detection settings: one late check-in is down, the next is up.",
      middleware: [editor],
      request: jsonBody(monitorInput),
      responses: { 201: json(monitorCreated, "The new monitor, with a heartbeat's ping URL") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      assertUnderCap(
        "monitors",
        (await monitors.listByWorkspace(member.workspaceId)).length,
        CAPS.monitors,
      );
      await validate(member, input);
      const created: MonitorConfig = {
        id: monitorId.parse(v7()),
        workspaceId: member.workspaceId,
        ...toStored(input),
      };
      await commit(deps, changeOf(member, "monitor", "created", [created.id], input), (tx) =>
        monitorRepository(tx).save(created),
      );
      const issuedAt = created.heartbeat?.tokenIssuedAt;
      return c.json(
        {
          ...toView(created),
          pingUrl: issuedAt ? pingUrlOf(deps, created.id, new Date(issuedAt)) : null,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/monitors/{id}",
      tags: ["Monitors"],
      summary: "Replace a monitor's settings",
      description: "Send every field; omitted optional fields fall back to their defaults.",
      middleware: [editor],
      request: { params: z.object({ id: monitorId }), ...jsonBody(monitorInput) },
      responses: { 200: json(monitorView, "The updated monitor") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const existing = (await monitors.findById(member.workspaceId, id)) ?? notFound("Monitor");
      if (existing.type !== input.type) {
        fail({
          status: 422,
          code: "type_changed",
          title: "A monitor keeps its type",
          detail: `This is ${existing.type === "heartbeat" ? "a heartbeat" : "an HTTP"} monitor. Add a new monitor of the other type instead.`,
        });
      }
      await validate(member, input);
      const updated: MonitorConfig = {
        id,
        workspaceId: member.workspaceId,
        ...toStored(input, existing),
      };
      await commit(deps, changeOf(member, "monitor", "updated", [id], input), (tx) =>
        monitorRepository(tx).save(updated),
      );
      return c.json(toView(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/monitors",
      tags: ["Monitors"],
      summary: "Pause or resume several monitors at once",
      description:
        "Every id must be one of this workspace's monitors, or nothing changes. Probes pick the change up with the next config publish.",
      middleware: [editor],
      request: jsonBody(monitorsEnabledInput),
      responses: {
        200: json(z.object({ monitors: z.array(monitorView) }), "Those monitors as they are now"),
      },
    }),
    async (c) => {
      const member = c.get("member");
      const { ids, enabled } = c.req.valid("json");
      const wanted = new Set(ids);
      const found = (await monitors.listByWorkspace(member.workspaceId)).filter((m) =>
        wanted.has(m.id),
      );
      if (found.length < wanted.size) notFound("Monitor");
      const changed = found.filter((m) => m.enabled !== enabled).map((m) => ({ ...m, enabled }));
      if (changed.length > 0) {
        const changedIds = changed.map((m) => m.id);
        await commit(
          deps,
          changeOf(member, "monitor", "updated", changedIds, { enabled, ids: changedIds }),
          async (tx) => {
            for (const monitor of changed) await monitorRepository(tx).save(monitor);
          },
        );
      }
      return c.json({ monitors: found.map((m) => toView({ ...m, enabled })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/monitors/{id}",
      tags: ["Monitors"],
      summary: "Delete a monitor; probes stop checking it with the next config publish",
      middleware: [editor],
      request: { params: z.object({ id: monitorId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await monitors.findById(member.workspaceId, id)) ?? notFound("Monitor");
      await commit(
        deps,
        changeOf(member, "monitor", "deleted", [id], { name: existing.name }),
        (tx) => monitorRepository(tx).delete(member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );
}
