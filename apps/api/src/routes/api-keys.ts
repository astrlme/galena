import { apiKeyCreated, apiKeyId, apiKeyInput, apiKeyView } from "@galena/contracts";
import { createApiKey, deleteApiKey, listApiKeys } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { newApiKey } from "../api-keys.ts";
import { type App, type Deps, notFound, requireRole } from "../http.ts";
import { changeOf, commit, json, jsonBody, noContent } from "./shared.ts";

// Keys for scripts. Only signed-in admins manage them: a key that could make keys would outlive
// any one key being deleted.

const session = [{ session: [] }];

export function registerApiKeyRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const admin = requireRole(deps, "admin", { keys: false });

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/api-keys",
      tags: ["Workspace"],
      summary: "API keys, newest first",
      security: session,
      middleware: [admin],
      responses: { 200: json(z.array(apiKeyView), "Keys, without the keys themselves") },
    }),
    async (c) => {
      const keys = await listApiKeys(db, c.get("member").workspaceId);
      return c.json(
        keys.map((k) => ({ ...k, createdAt: k.createdAt.toISOString() })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/api-keys",
      tags: ["Workspace"],
      summary: "Make an API key",
      description:
        "The key is in this answer only. It acts as you, at most at its scope: `read` as a viewer, `write` as an editor, `admin` as an admin.",
      security: session,
      middleware: [admin],
      request: jsonBody(apiKeyInput),
      responses: { 201: json(apiKeyCreated, "The key, shown once") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      const { key, prefix, hash } = newApiKey();
      const row = {
        id: apiKeyId.parse(v7()),
        workspaceId: member.workspaceId,
        name: input.name,
        scope: input.scope,
        prefix,
      };
      await commit(
        deps,
        changeOf(member, "api_key", "created", [row.id], { name: row.name, scope: row.scope }),
        (tx) => createApiKey(tx, { ...row, hash, createdByUserId: member.userId }),
      );
      const { workspaceId: _, ...view } = row;
      return c.json({ apiKey: { ...view, createdAt: new Date().toISOString() }, key }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/api-keys/{id}",
      tags: ["Workspace"],
      summary: "Delete an API key",
      description: "Scripts using it are refused from the next request.",
      security: session,
      middleware: [admin],
      request: { params: z.object({ id: apiKeyId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await listApiKeys(db, member.workspaceId)).find((k) => k.id === id);
      if (!existing) return notFound("API key");
      await commit(
        deps,
        changeOf(member, "api_key", "deleted", [id], { name: existing.name }),
        (tx) => deleteApiKey(tx, member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );
}
