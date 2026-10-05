import type { OutboxId } from "@galena/contracts";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../client.ts";
import { outbox } from "../schema/index.ts";

/** Undefined when the transaction that wrote it rolled back. */
export async function findOutboxRow(db: Db, id: OutboxId) {
  const [row] = await db
    .select({
      id: outbox.id,
      eventType: outbox.eventType,
      payload: outbox.payload,
      dispatchedAt: outbox.dispatchedAt,
    })
    .from(outbox)
    .where(eq(outbox.id, id))
    .limit(1);
  return row;
}

/** Rows written before `before` and still not dispatched, oldest first. */
export async function listPendingOutbox(db: Db, before: Date, limit: number): Promise<OutboxId[]> {
  const rows = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(isNull(outbox.dispatchedAt), lt(outbox.createdAt, before)))
    .orderBy(asc(outbox.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** False when another run marked it first. */
export async function markOutboxDispatched(db: Db, id: OutboxId, at: Date): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ dispatchedAt: at })
    .where(and(eq(outbox.id, id), isNull(outbox.dispatchedAt)))
    .returning({ id: outbox.id });
  return rows.length === 1;
}
