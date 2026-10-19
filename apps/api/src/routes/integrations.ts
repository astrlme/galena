import {
  hookUrl,
  type IntegrationId,
  integrationCreated,
  integrationId,
  integrationInput,
  integrationUpdate,
  integrationView,
  type SignalSource,
  type WorkspaceId,
} from "@galena/contracts";
import {
  createIntegration,
  deleteIntegration,
  findIntegration,
  type IntegrationRow,
  listIntegrations,
  setIntegrationToken,
  updateIntegration,
} from "@galena/db";
import { linkToken } from "@galena/integrations/secrets";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, notFound, requireRole } from "../http.ts";
import { CAPS, changeOf, commit, json, jsonBody, noContent, underCap } from "./shared.ts";

// Alert sources and their hook URLs. A URL carries a signed token, so only admins manage
// integrations, and the URL appears once: when the integration is made, and when a new URL
// replaces the old one (which stops working at once).

const toView = ({ workspaceId, tokenIssuedAt, ...i }: IntegrationRow) => ({
  ...i,
  lastSignalAt: i.lastSignalAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString(),
});
const idParam = z.object({ id: integrationId });
/** Whole seconds: the token carries its issue time in seconds. */
const wholeSecondNow = () => new Date(Math.floor(Date.now() / 1000) * 1000);

export function registerIntegrationRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;
  const admin = requireRole(deps, "admin");
  const urlOf = (source: SignalSource, id: IntegrationId, issuedAt: Date) =>
    new URL(`/hooks/${source}/${linkToken(keys, "hook", id, issuedAt)}`, deps.publicUrl).href;
  const owned = async (workspaceId: WorkspaceId, id: IntegrationId) => {
    const found = await findIntegration(db, id);
    return found?.workspaceId === workspaceId ? found : notFound("Integration");
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations",
      tags: ["Integrations"],
      summary: "Alert sources, oldest first",
      middleware: [admin],
      responses: { 200: json(z.array(integrationView), "Integrations, without their hook URLs") },
    }),
    async (c) => {
      const integrations = await listIntegrations(db, c.get("member").workspaceId);
      return c.json(integrations.map(toView), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations",
      tags: ["Integrations"],
      summary: "Add an alert source",
      description: "The hook URL is in this answer only.",
      middleware: [admin],
      request: jsonBody(integrationInput),
      responses: { 201: json(integrationCreated, "The integration and its hook URL") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      const existing = await listIntegrations(db, member.workspaceId);
      underCap("integrations", existing.length, CAPS.integrations);
      const row = {
        id: integrationId.parse(v7()),
        workspaceId: member.workspaceId,
        ...input,
        tokenIssuedAt: wholeSecondNow(),
      };
      await commit(
        deps,
        changeOf(member, "integration", "created", [row.id], {
          source: input.source,
          name: input.name,
        }),
        (tx) => createIntegration(tx, row),
      );
      const integration = { ...row, lastSignalAt: null, lastOutcome: null, createdAt: new Date() };
      return c.json(
        { integration: toView(integration), url: urlOf(row.source, row.id, row.tokenIssuedAt) },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/integrations/{id}",
      tags: ["Integrations"],
      summary: "Rename an integration, or change its policy or routes",
      middleware: [admin],
      request: { params: idParam, ...jsonBody(integrationUpdate) },
      responses: { 200: json(integrationView, "The updated integration") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const existing = await owned(member.workspaceId, id);
      await commit(deps, changeOf(member, "integration", "updated", [id], input), (tx) =>
        updateIntegration(tx, member.workspaceId, id, input),
      );
      return c.json(toView({ ...existing, ...input }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/{id}/url",
      tags: ["Integrations"],
      summary: "Make a new hook URL",
      description: "The old URL stops working at once. The new one is in this answer only.",
      middleware: [admin],
      request: { params: idParam },
      responses: { 200: json(hookUrl, "The new hook URL") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = await owned(member.workspaceId, id);
      // Later than the current URL's, even within its second, or the "new" URL would be the old.
      const after = existing.tokenIssuedAt.getTime() + 1000;
      const issuedAt = new Date(Math.max(wholeSecondNow().getTime(), after));
      await commit(
        deps,
        changeOf(member, "integration", "updated", [id], { url: "replaced" }),
        (tx) => setIntegrationToken(tx, member.workspaceId, id, issuedAt),
      );
      return c.json({ url: urlOf(existing.source, id, issuedAt) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/integrations/{id}",
      tags: ["Integrations"],
      summary: "Remove an integration; its hook URL stops working",
      middleware: [admin],
      request: { params: idParam },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = await owned(member.workspaceId, id);
      await commit(
        deps,
        changeOf(member, "integration", "deleted", [id], { name: existing.name }),
        (tx) => deleteIntegration(tx, member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );
}
