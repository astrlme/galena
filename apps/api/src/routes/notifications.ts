import {
  deliveryId,
  deliveryView,
  endpointCreated,
  endpointInput,
  endpointTestResult,
  endpointView,
  eventId,
  type Notice,
  noticeKinds,
  subscriberId,
  subscriberView,
  type WebhookEndpointId,
  type WorkspaceId,
  webhookEndpointId,
} from "@galena/contracts";
import { afterDelivery } from "@galena/core";
import {
  createEndpoint,
  deleteEndpoint,
  deleteSubscriber,
  type EndpointRow,
  ensurePage,
  findEndpointDelivery,
  findEndpointForSend,
  findSubscriber,
  listEndpointDeliveries,
  listEndpoints,
  listSubscribers,
  setEndpointHealth,
  settleResend,
} from "@galena/db";
import {
  newWebhookSecret,
  postJson,
  signWebhook,
  slackMessage,
  webhookBody,
} from "@galena/integrations/channels";
import { open, seal } from "@galena/integrations/secrets";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, notFound, requireRole } from "../http.ts";
import { changeOf, commit, json, jsonBody, noContent } from "./shared.ts";

// Where notices go besides email: Slack incoming webhooks and signed outgoing webhooks. Both
// carry credentials (Slack's in the URL), so only admins see or change them, and neither the
// URL nor the secret is ever returned after it is saved.

const toEndpointView = (e: EndpointRow) => ({
  ...e,
  failingSince: e.failingSince?.toISOString() ?? null,
  createdAt: e.createdAt.toISOString(),
});
/** "a***@example.com": enough to recognise, not enough to copy. */
const mask = (email: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, Math.min(1, at))}***${email.slice(at)}`;
};
const idParam = z.object({ id: webhookEndpointId });
const noticeKind = z.enum(noticeKinds);

function conflict(code: string, title: string, detail: string): never {
  return fail({ status: 409, code, title, detail });
}

export function registerNotificationRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;
  const admin = requireRole(deps, "admin");

  /** The workspace's endpoint with what a send needs; 404 for anyone else's. */
  async function ownedEndpoint(workspaceId: WorkspaceId, id: WebhookEndpointId) {
    const owned = (await listEndpoints(db, workspaceId)).find((e) => e.id === id);
    const endpoint = owned && (await findEndpointForSend(db, id));
    if (!owned || !endpoint) return notFound("Endpoint");
    return { ...endpoint, name: owned.name };
  }

  /**
   * Posts one notice to the endpoint now and says what it answered. A webhook is signed with
   * `messageId`, so a delivery sent again keeps its id and receivers can drop a duplicate.
   */
  async function postNow(
    endpoint: Awaited<ReturnType<typeof ownedEndpoint>>,
    notice: Notice,
    messageId: string,
    accepted: string,
  ) {
    const body =
      endpoint.kind === "slack" ? JSON.stringify(slackMessage(notice)) : webhookBody(notice);
    const headers =
      endpoint.kind === "webhook" && endpoint.secretSealed
        ? signWebhook({
            id: messageId,
            body,
            secret: open(keys, endpoint.secretSealed),
            at: new Date(),
          })
        : {};
    try {
      const { status } = await postJson({
        url: open(keys, endpoint.urlSealed),
        body,
        headers,
        guard: deps.targets,
      });
      const ok = status >= 200 && status < 300;
      return { ok, status, detail: ok ? accepted : `The endpoint answered HTTP ${status}.` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The request failed.";
      return { ok: false, status: 0, detail: `Couldn't reach the endpoint: ${reason}` };
    }
  }

  async function sampleNotice(): Promise<Notice> {
    const page = await ensurePage(db);
    const now = new Date().toISOString();
    const url = `${deps.publicUrl}/dashboard/subscribers/`;
    return {
      kind: "incident_created",
      eventId: eventId.parse(v7()),
      page: { name: page?.name ?? "Galena", url },
      title: "Test notification",
      status: "investigating",
      impact: "none",
      components: [],
      body: "This is a test from the dashboard. Nothing is wrong.",
      startsAt: now,
      endsAt: null,
      occurredAt: now,
      url,
    };
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhook-endpoints",
      tags: ["Notifications"],
      summary: "Slack and webhook endpoints, oldest first",
      middleware: [admin],
      responses: { 200: json(z.array(endpointView), "Endpoints, without their URLs or secrets") },
    }),
    async (c) => {
      const endpoints = await listEndpoints(db, c.get("member").workspaceId);
      return c.json(endpoints.map(toEndpointView), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhook-endpoints",
      tags: ["Notifications"],
      summary: "Add a Slack incoming webhook or an outgoing webhook",
      description: "An outgoing webhook's signing secret is in this answer only.",
      middleware: [admin],
      request: jsonBody(endpointInput),
      responses: { 201: json(endpointCreated, "The endpoint, and a webhook's signing secret") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      const checked = deps.targets.checkUrl(input.url);
      if (!checked.ok) {
        fail({
          status: 422,
          code: "blocked_by_guard",
          title: "That address can't be used",
          detail: `${checked.error.message} Use a public https:// address.`,
        });
      }
      const secret = input.kind === "webhook" ? newWebhookSecret() : null;
      const row = {
        id: webhookEndpointId.parse(v7()),
        workspaceId: member.workspaceId,
        kind: input.kind,
        name: input.name,
        componentIds: input.componentIds,
      };
      await commit(
        deps,
        changeOf(member, "webhook_endpoint", "created", [row.id], {
          kind: input.kind,
          name: input.name,
        }),
        (tx) =>
          createEndpoint(tx, {
            ...row,
            urlSealed: seal(keys, input.url),
            secretSealed: secret ? seal(keys, secret) : null,
          }),
      );
      const created = {
        ...row,
        state: "active" as const,
        failingSince: null,
        createdAt: new Date(),
      };
      return c.json({ endpoint: toEndpointView(created), secret }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/webhook-endpoints/{id}",
      tags: ["Notifications"],
      summary: "Remove an endpoint",
      middleware: [admin],
      request: { params: idParam },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await listEndpoints(db, member.workspaceId)).find((e) => e.id === id);
      if (!existing) return notFound("Endpoint");
      await commit(
        deps,
        changeOf(member, "webhook_endpoint", "deleted", [id], { name: existing.name }),
        (tx) => deleteEndpoint(tx, member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhook-endpoints/{id}/test",
      tags: ["Notifications"],
      summary: "Send a test message",
      description: "Posts a sample notice now and says what the endpoint answered.",
      middleware: [admin],
      request: { params: idParam },
      responses: { 200: json(endpointTestResult, "What the endpoint answered") },
    }),
    async (c) => {
      const endpoint = await ownedEndpoint(c.get("member").workspaceId, c.req.valid("param").id);
      const accepted = "The endpoint accepted the test message.";
      return c.json(await postNow(endpoint, await sampleNotice(), `test_${v7()}`, accepted), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhook-endpoints/{id}/enable",
      tags: ["Notifications"],
      summary: "Turn a disabled endpoint on again",
      description: "Posts a test message first; the endpoint is on again only if it accepts it.",
      middleware: [admin],
      request: { params: idParam },
      responses: { 200: json(endpointTestResult, "What the endpoint answered") },
    }),
    async (c) => {
      const member = c.get("member");
      const endpoint = await ownedEndpoint(member.workspaceId, c.req.valid("param").id);
      if (endpoint.state !== "disabled") {
        conflict("not_disabled", "The endpoint is on", "It already gets notifications.");
      }
      const accepted = "The endpoint accepted the test message and is on again.";
      const result = await postNow(endpoint, await sampleNotice(), `test_${v7()}`, accepted);
      if (result.ok) {
        const change = changeOf(member, "webhook_endpoint", "updated", [endpoint.id], {
          name: endpoint.name,
          state: "active",
        });
        await commit(deps, change, (tx) =>
          setEndpointHealth(tx, endpoint.id, "disabled", { state: "active", failingSince: null }),
        );
      }
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhook-endpoints/{id}/deliveries",
      tags: ["Notifications"],
      summary: "An endpoint's deliveries, newest first",
      description: "The last 50 notices sent or being sent to it, and how each one went.",
      middleware: [admin],
      request: { params: idParam },
      responses: { 200: json(z.array(deliveryView), "Deliveries") },
    }),
    async (c) => {
      const member = c.get("member");
      const endpoint = await ownedEndpoint(member.workspaceId, c.req.valid("param").id);
      const rows = await listEndpointDeliveries(db, member.workspaceId, endpoint.id);
      return c.json(
        rows.map((d) => ({
          ...d,
          kind: noticeKind.safeParse(d.kind).data ?? null,
          sentAt: d.sentAt?.toISOString() ?? null,
          createdAt: d.createdAt.toISOString(),
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhook-endpoints/{id}/deliveries/{deliveryId}/resend",
      tags: ["Notifications"],
      summary: "Send a delivery again",
      description:
        "Posts the same notice now, with the same webhook id, and records how it went. A delivery still being retried waits for its retries.",
      middleware: [admin],
      request: { params: idParam.extend({ deliveryId }) },
      responses: { 200: json(endpointTestResult, "What the endpoint answered") },
    }),
    async (c) => {
      const member = c.get("member");
      const params = c.req.valid("param");
      const endpoint = await ownedEndpoint(member.workspaceId, params.id);
      const delivery = await findEndpointDelivery(
        db,
        member.workspaceId,
        endpoint.id,
        params.deliveryId,
      );
      if (!delivery) return notFound("Delivery");
      if (endpoint.state === "disabled") {
        conflict("endpoint_disabled", "The endpoint is off", "Turn it on, then send this again.");
      }
      if (delivery.status === "pending") {
        conflict(
          "still_retrying",
          "It's still being retried",
          "Galena tries it again at its time. Send it again once it has failed.",
        );
      }
      if (!delivery.notice) {
        conflict(
          "not_kept",
          "It can't be sent again",
          "It was sent before Galena kept what each delivery carried.",
        );
      }
      const accepted = "The endpoint accepted it.";
      const result = await postNow(endpoint, delivery.notice, delivery.id, accepted);
      const now = new Date();
      await settleResend(
        db,
        delivery.id,
        result.ok
          ? { status: "sent", sentAt: now }
          : { status: "failed", lastError: result.detail },
      );
      const next = afterDelivery(endpoint, result.ok ? "sent" : "failed", now);
      if (next.state !== endpoint.state) {
        await setEndpointHealth(db, endpoint.id, endpoint.state, next);
      }
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/subscribers",
      tags: ["Notifications"],
      summary: "Email subscribers, newest first",
      middleware: [admin],
      responses: { 200: json(z.array(subscriberView), "Subscribers, with masked addresses") },
    }),
    async (c) => {
      const rows = await listSubscribers(db, c.get("member").workspaceId);
      return c.json(
        rows.map((s) => ({
          id: s.id,
          email: mask(s.email),
          state: s.state,
          componentIds: s.componentIds,
          createdAt: s.createdAt.toISOString(),
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/subscribers/{id}",
      tags: ["Notifications"],
      summary: "Remove a subscriber",
      description: "Deletes the address; it can subscribe again, even after a bounce.",
      middleware: [admin],
      request: { params: z.object({ id: subscriberId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = await findSubscriber(db, id);
      if (existing?.workspaceId !== member.workspaceId) return notFound("Subscriber");
      // The audit entry names the row only: the address stays out of the log.
      await commit(deps, changeOf(member, "subscriber", "deleted", [id]), (tx) =>
        deleteSubscriber(tx, member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );
}
