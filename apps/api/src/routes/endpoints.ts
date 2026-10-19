import {
  deliveryId,
  deliveryView,
  endpointCreated,
  endpointInput,
  endpointTestResult,
  endpointView,
  eventId,
  type Notice,
  type WebhookEndpointId,
  type WorkspaceId,
  webhookEndpointId,
} from "@galena/contracts";
import { afterDelivery, resendStep } from "@galena/core";
import {
  claimResend,
  createEndpoint,
  deleteEndpoint,
  type EndpointRow,
  ensurePage,
  findEndpointDelivery,
  findEndpointForSend,
  listEndpointDeliveries,
  listEndpoints,
  setEndpointHealth,
  settleResend,
} from "@galena/db";
import {
  type EndpointAnswer,
  endpointRequest,
  newWebhookSecret,
  postToEndpoint,
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
const idParam = z.object({ id: webhookEndpointId });
/** What the dashboard shows after a test, a resend or turning an endpoint on. */
const said = (answer: EndpointAnswer, accepted: string, refused: (error: string) => string) => ({
  ok: answer.ok,
  status: answer.status,
  detail: answer.ok ? accepted : refused(answer.error),
});

export function registerEndpointRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;
  const admin = requireRole(deps, "admin");

  /** The workspace's endpoint with what a send needs; 404 for anyone else's. */
  async function ownedEndpoint(workspaceId: WorkspaceId, id: WebhookEndpointId) {
    const owned = (await listEndpoints(db, workspaceId)).find((e) => e.id === id);
    const endpoint = owned && (await findEndpointForSend(db, id));
    if (!owned || !endpoint) return notFound("Endpoint");
    return { ...endpoint, name: owned.name };
  }

  /** Posts one notice to the endpoint now, signed with `messageId` for a webhook. */
  function postNow(
    endpoint: Awaited<ReturnType<typeof ownedEndpoint>>,
    notice: Notice,
    messageId: string,
  ) {
    const request = endpointRequest(endpoint.kind, notice, {
      id: messageId,
      secret: endpoint.secretSealed && open(keys, endpoint.secretSealed),
      at: new Date(),
    });
    return postToEndpoint({ ...request, url: open(keys, endpoint.urlSealed), guard: deps.targets });
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
      const answer = await postNow(endpoint, await sampleNotice(), `test_${v7()}`);
      const accepted = "The endpoint accepted the test message.";
      return c.json(
        said(answer, accepted, (error) => error),
        200,
      );
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
        fail({
          status: 409,
          code: "not_disabled",
          title: "The endpoint is on",
          detail: "It already gets notifications.",
        });
      }
      const answer = await postNow(endpoint, await sampleNotice(), `test_${v7()}`);
      if (answer.ok) {
        const change = changeOf(member, "webhook_endpoint", "updated", [endpoint.id], {
          name: endpoint.name,
          state: "active",
        });
        await commit(deps, change, (tx) =>
          setEndpointHealth(tx, endpoint.id, endpoint, { state: "active", failingSince: null }),
        );
      }
      const result = said(
        answer,
        "Turned on. The endpoint accepted the test message.",
        (error) => `Still off. ${error} Fix the receiver, then turn it on again.`,
      );
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
        "Posts the same notice now, with the same webhook id, as one more attempt. A delivery still being retried waits for its next attempt, unless that is two hours late.",
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
      const now = new Date();
      const step = resendStep(delivery, endpoint, now);
      if (!step.ok) {
        const { code, message } = step.error;
        fail({ status: 409, code, title: "It can't be sent again now", detail: message });
      }
      // Claimed before the post: a second press, or a retry arriving now, finds it taken.
      const attempts = await claimResend(db, delivery.id, delivery.attempts);
      if (attempts === undefined) {
        fail({
          status: 409,
          code: "already_sending",
          title: "It's being sent already",
          detail: "Another attempt took it first. Reload the deliveries to see how it went.",
        });
      }
      const answer = await postNow(endpoint, step.value, delivery.id);
      await settleResend(
        db,
        delivery.id,
        attempts,
        answer.ok ? { status: "sent", sentAt: now } : { status: "failed", lastError: answer.error },
      );
      // Getting through brings a failing endpoint back; one manual try failing says nothing new.
      if (answer.ok && endpoint.state === "failing") {
        await setEndpointHealth(db, endpoint.id, endpoint, afterDelivery(endpoint, "sent", now));
      }
      const result = said(
        answer,
        "Sent again. The endpoint accepted it.",
        (error) => `Not sent. ${error}`,
      );
      return c.json(result, 200);
    },
  );
}
