import {
  componentGroupId,
  componentGroupInput,
  componentGroupView,
  componentId,
  componentInput,
  componentPatch,
  componentView,
  reorderInput,
} from "@galena/contracts";
import { type Component, type ComponentGroup, reorder } from "@galena/core";
import { componentGroupRepository, componentRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import { changeOf, commit, json, jsonBody, noContent } from "./shared.ts";

const toComponentView = (c: Component) => ({
  id: c.id,
  groupId: c.groupId,
  name: c.name,
  description: c.description,
  position: c.position,
  status: c.status,
});
const toGroupView = (g: ComponentGroup) => ({ id: g.id, name: g.name, position: g.position });

function orderMismatch(message: string): never {
  return fail({
    status: 409,
    code: "order_mismatch",
    title: "The order is out of date",
    detail: message,
  });
}

export function registerComponentRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const viewer = requireRole(deps, "viewer");
  const editor = requireRole(deps, "editor");
  const components = componentRepository(db);
  const groups = componentGroupRepository(db);

  async function requireGroup(member: Member, id: z.infer<typeof componentGroupId> | null) {
    if (id !== null && !(await groups.findById(member.workspaceId, id))) {
      fail({
        status: 422,
        code: "group_not_found",
        title: "That group does not exist",
        detail: "Pick a group from the list, or leave the component ungrouped.",
      });
    }
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/components",
      summary: "Components and their groups, in page order",
      middleware: [viewer],
      responses: {
        200: json(
          z.object({ groups: z.array(componentGroupView), components: z.array(componentView) }),
          "Groups and components, each ordered by position",
        ),
      },
    }),
    async (c) => {
      const { workspaceId } = c.get("member");
      const [groupList, componentList] = await Promise.all([
        groups.listByWorkspace(workspaceId),
        components.listByWorkspace(workspaceId),
      ]);
      return c.json(
        { groups: groupList.map(toGroupView), components: componentList.map(toComponentView) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/components",
      summary: "Add a component at the end of the list",
      middleware: [editor],
      request: jsonBody(componentInput),
      responses: { 201: json(componentView, "The new component") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      await requireGroup(member, input.groupId);
      const created: Component = {
        id: componentId.parse(v7()),
        workspaceId: member.workspaceId,
        ...input,
        position: (await components.listByWorkspace(member.workspaceId)).length,
        status: "operational",
        manualStatus: null,
      };
      await commit(deps, changeOf(member, "component", "created", [created.id], input), (tx) =>
        componentRepository(tx).save(created),
      );
      return c.json(toComponentView(created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/components/{id}",
      summary: "Rename, describe or regroup a component",
      middleware: [editor],
      request: { params: z.object({ id: componentId }), ...jsonBody(componentPatch) },
      responses: { 200: json(componentView, "The updated component") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const existing = (await components.findById(member.workspaceId, id)) ?? notFound("Component");
      if (patch.groupId !== undefined) await requireGroup(member, patch.groupId);
      // Omitted fields stay as they are; null clears description or group.
      const updated: Component = {
        ...existing,
        name: patch.name ?? existing.name,
        description: patch.description === undefined ? existing.description : patch.description,
        groupId: patch.groupId === undefined ? existing.groupId : patch.groupId,
      };
      await commit(deps, changeOf(member, "component", "updated", [id], patch), (tx) =>
        componentRepository(tx).save(updated),
      );
      return c.json(toComponentView(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/components/{id}",
      summary: "Delete a component from every page",
      middleware: [editor],
      request: { params: z.object({ id: componentId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await components.findById(member.workspaceId, id)) ?? notFound("Component");
      await commit(
        deps,
        changeOf(member, "component", "deleted", [id], { name: existing.name }),
        (tx) => componentRepository(tx).delete(member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/components/order",
      summary: "Set the order of every component",
      middleware: [editor],
      request: jsonBody(reorderInput),
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { ids } = c.req.valid("json");
      const current = await components.listByWorkspace(member.workspaceId);
      const result = reorder(
        current.map((x) => x.id),
        ids,
      );
      if (!result.ok) orderMismatch(result.error.message);
      await commit(deps, changeOf(member, "component", "reordered", ids), (tx) =>
        componentRepository(tx).setPositions(member.workspaceId, result.value),
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/component-groups",
      summary: "Add a group at the end of the list",
      middleware: [editor],
      request: jsonBody(componentGroupInput),
      responses: { 201: json(componentGroupView, "The new group") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      const created: ComponentGroup = {
        id: componentGroupId.parse(v7()),
        workspaceId: member.workspaceId,
        name: input.name,
        position: (await groups.listByWorkspace(member.workspaceId)).length,
      };
      await commit(
        deps,
        changeOf(member, "component_group", "created", [created.id], input),
        (tx) => componentGroupRepository(tx).save(created),
      );
      return c.json(toGroupView(created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/component-groups/{id}",
      summary: "Rename a group",
      middleware: [editor],
      request: { params: z.object({ id: componentGroupId }), ...jsonBody(componentGroupInput) },
      responses: { 200: json(componentGroupView, "The updated group") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const existing = (await groups.findById(member.workspaceId, id)) ?? notFound("Group");
      const updated: ComponentGroup = { ...existing, name: input.name };
      await commit(deps, changeOf(member, "component_group", "updated", [id], input), (tx) =>
        componentGroupRepository(tx).save(updated),
      );
      return c.json(toGroupView(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/component-groups/{id}",
      summary: "Delete a group; its components stay, ungrouped",
      middleware: [editor],
      request: { params: z.object({ id: componentGroupId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await groups.findById(member.workspaceId, id)) ?? notFound("Group");
      await commit(
        deps,
        changeOf(member, "component_group", "deleted", [id], { name: existing.name }),
        (tx) => componentGroupRepository(tx).delete(member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/component-groups/order",
      summary: "Set the order of every group",
      middleware: [editor],
      request: jsonBody(reorderInput),
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { ids } = c.req.valid("json");
      const current = await groups.listByWorkspace(member.workspaceId);
      const result = reorder(
        current.map((x) => x.id),
        ids,
      );
      if (!result.ok) orderMismatch(result.error.message);
      await commit(deps, changeOf(member, "component_group", "reordered", ids), (tx) =>
        componentGroupRepository(tx).setPositions(member.workspaceId, result.value),
      );
      return c.body(null, 204);
    },
  );
}
