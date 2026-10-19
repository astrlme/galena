import {
  type ApiKeyId,
  type AuditLogId,
  apiKeyScopes,
  type MemberId,
  memberRoles,
  type OutboxId,
  type WorkspaceId,
} from "@galena/contracts";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { timestamps } from "./columns.ts";

export const workspace = pgTable("workspace", {
  id: uuid().primaryKey().$type<WorkspaceId>(),
  name: text().notNull(),
  ...timestamps,
});

/** The tenant key every workspace-owned table carries. */
export const workspaceRef = () =>
  uuid()
    .notNull()
    .$type<WorkspaceId>()
    .references(() => workspace.id, { onDelete: "cascade" });

export const memberRole = pgEnum("member_role", memberRoles);

/** A user's role in a workspace; the only link between identities and tenants. */
export const member = pgTable(
  "member",
  {
    id: uuid().primaryKey().$type<MemberId>(),
    workspaceId: workspaceRef(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.userId), index().on(t.userId)],
);

export const apiKeyScope = pgEnum("api_key_scope", apiKeyScopes);

/**
 * A key a script sends as `Authorization: Bearer gln_…`. Only its SHA-256 is kept, with its
 * first characters to tell keys apart. It acts as the member who made it, and references that
 * membership, so a maker who leaves the workspace takes their keys with them.
 */
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid().primaryKey().$type<ApiKeyId>(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    scope: apiKeyScope().notNull(),
    prefix: text().notNull(),
    hash: text().notNull(),
    createdByUserId: text().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.hash),
    index().on(t.workspaceId, t.createdByUserId),
    foreignKey({
      name: "api_key_member_fk",
      columns: [t.workspaceId, t.createdByUserId],
      foreignColumns: [member.workspaceId, member.userId],
    }).onDelete("cascade"),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().$type<AuditLogId>(),
    workspaceId: workspaceRef(),
    actorUserId: text().references(() => user.id, { onDelete: "set null" }),
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: uuid(),
    data: jsonb(),
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId, t.createdAt), index().on(t.actorUserId)],
);

/** Domain events written in the same transaction as the change they describe. */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid().primaryKey().$type<OutboxId>(),
    workspaceId: workspaceRef(),
    eventType: text().notNull(),
    payload: jsonb().notNull(),
    dispatchedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.workspaceId),
    // The outbox sweep reads only pending rows.
    index("outbox_pending_idx").on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
  ],
);
