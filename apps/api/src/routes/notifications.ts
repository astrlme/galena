import {
  endpointCreated,
  endpointInput,
  endpointTestResult,
  endpointView,
  eventId,
  type Notice,
  subscriberId,
  subscriberView,
  webhookEndpointId,
} from "@galena/contracts";
import {
  createEndpoint,
  deleteEndpoint,
  deleteSubscriber,
  type EndpointRow,
  ensurePage,
  findEndpointForSend,
  findSubscriber,
  listEndpoints,
  listSubscribers,
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

export function registerNotificationRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;
  const admin = requireRole(deps, "admin");

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhook-endpoints",
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
      summary: "Send a test message",
      description: "Posts a sample notice now and says what the endpoint answered.",
      middleware: [admin],
      request: { params: idParam },
      responses: { 200: json(endpointTestResult, "What the endpoint answered") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const owned = (await listEndpoints(db, member.workspaceId)).some((e) => e.id === id);
      const endpoint = owned ? await findEndpointForSend(db, id) : undefined;
      if (!endpoint) return notFound("Endpoint");
      const page = await ensurePage(db);
      const now = new Date().toISOString();
      const url = `${deps.publicUrl}/dashboard/subscribers/`;
      const sample: Notice = {
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
      const body =
        endpoint.kind === "slack" ? JSON.stringify(slackMessage(sample)) : webhookBody(sample);
      const headers =
        endpoint.kind === "webhook" && endpoint.secretSealed
          ? signWebhook({
              id: `test_${v7()}`,
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
        return c.json(
          {
            ok,
            status,
            detail: ok
              ? "The endpoint accepted the test message."
              : `The endpoint answered HTTP ${status}.`,
          },
          200,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The request failed.";
        return c.json(
          { ok: false, status: 0, detail: `Couldn't reach the endpoint: ${reason}` },
          200,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/subscribers",
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
