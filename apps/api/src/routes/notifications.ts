import { subscriberId, subscriberView } from "@galena/contracts";
import { deleteSubscriber, findSubscriber, listSubscribers } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, notFound, requireRole } from "../http.ts";
import { changeOf, commit, json, noContent } from "./shared.ts";

// Email subscribers sign up on the status page; addresses are personal data, so only admins
// see them, and masked.

/** "a***@example.com": enough to recognise, not enough to copy. */
const mask = (email: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, Math.min(1, at))}***${email.slice(at)}`;
};

export function registerNotificationRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const admin = requireRole(deps, "admin");

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
