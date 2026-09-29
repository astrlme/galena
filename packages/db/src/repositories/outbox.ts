import type { OutboxId } from "@galena/contracts";
import { and, eq, isNull } from "drizzle-orm";
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

/** False when another run marked it first. */
export async function markOutboxDispatched(db: Db, id: OutboxId, at: Date): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ dispatchedAt: at })
    .where(and(eq(outbox.id, id), isNull(outbox.dispatchedAt)))
    .returning({ id: outbox.id });
  return rows.length === 1;
}
