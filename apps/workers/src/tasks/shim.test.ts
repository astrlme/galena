import { expect, test, vi } from "vitest";

vi.mock("./keys.ts", () => ({ globalKey: async (key: string) => `global(${key})` }));
const { runOptions } = await import("./shim.ts");

test("a run's key is made global, and a start time becomes its delay", async () => {
  const at = new Date("2026-10-15T10:10:00.000Z");
  expect(await runOptions("incident.autopilot", { idempotencyKey: "auto:i1", at })).toEqual({
    idempotencyKey: "global(auto:i1)",
    delay: at,
  });
  expect(await runOptions("outbox.dispatch", { idempotencyKey: "outbox:o1" })).toEqual({
    idempotencyKey: "global(outbox:o1)",
  });
});

test("only endpoint sends get a concurrency key, one per destination", async () => {
  expect(await runOptions("notify.slack", { idempotencyKey: "send:e1:end1" })).toMatchObject({
    concurrencyKey: "slack:end1",
  });
  expect(await runOptions("notify.webhook", { idempotencyKey: "send:e1:end2" })).toMatchObject({
    concurrencyKey: "webhook:end2",
  });
  for (const task of ["notify.email", "page.publish", "monitor.state-changed"]) {
    expect(await runOptions(task, { idempotencyKey: "send:e1:s1" })).not.toHaveProperty(
      "concurrencyKey",
    );
  }
});
