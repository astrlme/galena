import { outboxId } from "@galena/contracts";
import { v7 } from "uuid";
import { expect, test } from "vitest";
import { type DispatchPayload, retryDispatch } from "./outbox-triggers.ts";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const id = outboxId.parse(v7());

function scheduler() {
  const scheduled: { payload: DispatchPayload; key: string; at: string }[] = [];
  return {
    scheduled,
    deps: {
      clock: { now: () => NOW },
      schedule: async (payload: DispatchPayload, options: { idempotencyKey: string; at: Date }) =>
        void scheduled.push({ payload, key: options.idempotencyKey, at: options.at.toISOString() }),
    },
  };
}

test("a dispatch that failed every attempt runs again at 5 minutes, 15 minutes and an hour", async () => {
  const { scheduled, deps } = scheduler();
  const outage = new Error("DatabaseResumingException");

  await retryDispatch({ outboxId: id }, outage, deps);
  await retryDispatch({ outboxId: id, retry: 1 }, outage, deps);
  await retryDispatch({ outboxId: id, retry: 2 }, outage, deps);

  expect(scheduled).toEqual([
    {
      payload: { outboxId: id, retry: 1 },
      key: `outbox:${id}:retry:1`,
      at: "2026-11-11T12:05:00.000Z",
    },
    {
      payload: { outboxId: id, retry: 2 },
      key: `outbox:${id}:retry:2`,
      at: "2026-11-11T12:15:00.000Z",
    },
    {
      payload: { outboxId: id, retry: 3 },
      key: `outbox:${id}:retry:3`,
      at: "2026-11-11T13:00:00.000Z",
    },
  ]);
});

test("after the last retry the failure stays unrecorded, for the dead-letter queue", async () => {
  const { scheduled, deps } = scheduler();
  const outage = new Error("DatabaseResumingException");

  await expect(retryDispatch({ outboxId: id, retry: 3 }, outage, deps)).rejects.toBe(outage);
  expect(scheduled).toEqual([]);
});
