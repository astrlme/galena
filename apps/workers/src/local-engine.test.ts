import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { cronMatches, localEngine, startCrons } from "./local-engine.ts";
import { defineJob, type Job } from "./runner.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

const id = z.object({ id: z.string() });

/** A job whose runs record what they did and wait until `release` is called. */
function recording(name: string) {
  const events: string[] = [];
  let release: () => void = () => {};
  const job = defineJob({
    name,
    payload: id,
    run: async ({ id }) => {
      events.push(`start ${id}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push(`end ${id}`);
    },
  });
  return { job, events, release: () => release() };
}

const registry = <P>(job: Job<P>) => new Map([[job.name, job as unknown as Job<unknown>]]);

test("jobs in one lane run one at a time, in order", async () => {
  const outbox = recording("outbox.dispatch");
  const engine = localEngine(registry(outbox.job));
  await engine.trigger("outbox.dispatch", { id: "a" }, { idempotencyKey: "outbox:a" });
  await engine.trigger("outbox.dispatch", { id: "b" }, { idempotencyKey: "outbox:b" });
  await vi.advanceTimersByTimeAsync(0);
  expect(outbox.events).toEqual(["start a"]);
  outbox.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(outbox.events).toEqual(["start a", "end a", "start b"]);
});

test("jobs in different lanes run side by side", async () => {
  const card = recording("slack.approval-card");
  const engine = localEngine(registry(card.job));
  await engine.trigger("slack.approval-card", { id: "a" }, { idempotencyKey: "card:a" });
  await engine.trigger("slack.approval-card", { id: "b" }, { idempotencyKey: "card:b" });
  await vi.advanceTimersByTimeAsync(0);
  expect(card.events).toEqual(["start a", "start b"]);
});

test("a key starts its job once", async () => {
  const runs: string[] = [];
  const job = defineJob({
    name: "page.publish",
    payload: id,
    run: async ({ id }) => void runs.push(id),
  });
  const engine = localEngine(registry(job));
  await engine.trigger("page.publish", { id: "9" }, { idempotencyKey: "pub:9" });
  await engine.trigger("page.publish", { id: "9" }, { idempotencyKey: "pub:9" });
  await engine.triggerAll("page.publish", [
    { payload: { id: "9" }, options: { idempotencyKey: "pub:9" } },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toEqual(["9"]);
});

test("a job started at a time runs then, not before", async () => {
  const runs: string[] = [];
  const job = defineJob({
    name: "incident.autopilot",
    payload: id,
    run: async ({ id }) => void runs.push(id),
  });
  const engine = localEngine(registry(job));
  await engine.trigger(
    "incident.autopilot",
    { id: "draft" },
    { idempotencyKey: "auto:draft", at: new Date("2026-10-15T10:10:00.000Z") },
  );
  await vi.advanceTimersByTimeAsync(9 * 60_000 + 59_000);
  expect(runs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(runs).toEqual(["draft"]);
});

test("a job a month away waits past setTimeout's longest wait and runs on its day", async () => {
  const runs: string[] = [];
  const job = defineJob({
    name: "maintenance.lifecycle",
    payload: id,
    run: async ({ id }) => void runs.push(id),
  });
  const engine = localEngine(registry(job));
  const month = 30 * 24 * 60 * 60_000;
  await engine.trigger(
    "maintenance.lifecycle",
    { id: "window" },
    { idempotencyKey: "mnt:w:1:scheduled", at: new Date(Date.now() + month) },
  );
  await vi.advanceTimersByTimeAsync(month - 1_000);
  expect(runs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(runs).toEqual(["window"]);
});

test("a failing job is tried again after its wait, and its failure hook runs once at the end", async () => {
  const attempts: number[] = [];
  const failures: unknown[] = [];
  const job = defineJob({
    name: "notify.email",
    payload: id,
    retry: { attempts: 3, minMs: 1_000, maxMs: 60_000, factor: 2 },
    run: async (_, { attempt }) => {
      attempts.push(attempt);
      throw new Error("throttled");
    },
    onFailure: async (payload) => void failures.push(payload),
  });
  const engine = localEngine(registry(job));
  await engine.trigger("notify.email", { id: "s" }, { idempotencyKey: "send:e:s" });
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toEqual([1]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(attempts).toEqual([1, 2]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect([attempts, failures]).toEqual([[1, 2, 3], [{ id: "s" }]]);
});

test("a job that fails for good leaves its lane free for the next one", async () => {
  const runs: string[] = [];
  const job = defineJob({
    name: "outbox.dispatch",
    payload: id,
    run: async ({ id }) => {
      runs.push(id);
      if (id === "bad") throw new Error("no");
    },
  });
  const engine = localEngine(registry(job));
  await engine.trigger("outbox.dispatch", { id: "bad" }, { idempotencyKey: "outbox:bad" });
  await engine.trigger("outbox.dispatch", { id: "good" }, { idempotencyKey: "outbox:good" });
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toEqual(["bad", "good"]);
});

test("a job nobody defined is refused at once", async () => {
  await expect(
    localEngine(new Map()).trigger("nope", {}, { idempotencyKey: "nope:1" }),
  ).rejects.toThrow("nope");
});

test("cron patterns match the minutes they name", () => {
  const at = (iso: string) => new Date(iso);
  expect(cronMatches("35 * * * *", at("2026-10-15T07:35:00Z"))).toBe(true);
  expect(cronMatches("35 * * * *", at("2026-10-15T07:36:00Z"))).toBe(false);
  expect(cronMatches("5 */6 * * *", at("2026-10-15T12:05:00Z"))).toBe(true);
  expect(cronMatches("5 */6 * * *", at("2026-10-15T13:05:00Z"))).toBe(false);
  // Day, month and weekday aren't read, so a pattern that sets them is refused, not ignored.
  expect(() => cronMatches("0 9 * * 1", at("2026-10-15T09:00:00Z"))).toThrow("must be *");
});

test("a scheduled job runs at its minute, with that minute as its timestamp", async () => {
  vi.setSystemTime(new Date("2026-10-15T10:34:30.000Z"));
  const timestamps: string[] = [];
  const job = defineJob({
    name: "page.heartbeat",
    payload: z.object({ timestamp: z.string() }),
    run: async ({ timestamp }) => void timestamps.push(timestamp),
  });
  const engine = localEngine(registry(job));
  const stop = startCrons([{ job, pattern: "35 * * * *" }], engine);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(timestamps).toEqual(["2026-10-15T10:35:00.000Z"]);
  await vi.advanceTimersByTimeAsync(59 * 60_000);
  expect(timestamps).toHaveLength(1);
  stop();
});
