import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineJob, FinalError, runAttempt } from "./runner.ts";

const failures: unknown[] = [];
const job = (
  run: () => Promise<unknown>,
  retry = { attempts: 5, minMs: 2_000, maxMs: 60_000, factor: 2 },
) =>
  defineJob({
    name: "test.job",
    payload: z.object({ id: z.string() }),
    retry,
    run,
    onFailure: async (payload, error) => void failures.push([payload, error]),
  });

describe("runAttempt", () => {
  test("a job that succeeds is done, with its result", async () => {
    expect(
      await runAttempt(
        job(async () => ({ outcome: "sent" })),
        { id: "a" },
        1,
      ),
    ).toEqual({
      outcome: "done",
      result: { outcome: "sent" },
    });
  });

  test("a failure is retried after a wait that grows by the factor, up to the maximum", async () => {
    const failing = job(async () => {
      throw new Error("throttled");
    });
    const waits = [];
    for (const attempt of [1, 2, 3, 4]) {
      const result = await runAttempt(failing, { id: "a" }, attempt);
      if (result.outcome !== "retry") throw new Error(`attempt ${attempt} did not retry`);
      waits.push(result.afterMs);
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000]);
    const capped = job(
      async () => {
        throw new Error("down");
      },
      { attempts: 10, minMs: 5_000, maxMs: 600_000, factor: 3 },
    );
    expect(await runAttempt(capped, { id: "a" }, 7)).toMatchObject({ afterMs: 600_000 });
    expect(failures).toEqual([]);
  });

  test("the last attempt runs the failure hook once and fails", async () => {
    failures.length = 0;
    const error = new Error("still down");
    const result = await runAttempt(
      job(async () => Promise.reject(error)),
      { id: "a" },
      5,
    );
    expect(result).toEqual({ outcome: "failed", error });
    expect(failures).toEqual([[{ id: "a" }, error]]);
  });

  test("a final error fails at once, with the failure hook", async () => {
    failures.length = 0;
    const error = new FinalError("MessageRejected");
    const result = await runAttempt(
      job(async () => Promise.reject(error)),
      { id: "a" },
      1,
    );
    expect(result).toEqual({ outcome: "failed", error });
    expect(failures).toEqual([[{ id: "a" }, error]]);
  });

  test("a payload that doesn't parse fails at once and never runs the job or its hook", async () => {
    failures.length = 0;
    let ran = false;
    const result = await runAttempt(
      job(async () => {
        ran = true;
      }),
      { id: 42 },
      1,
    );
    expect(result.outcome).toBe("failed");
    expect([ran, failures]).toEqual([false, []]);
  });

  test("a job with no retry settings fails on its first error", async () => {
    const once = defineJob({
      name: "test.once",
      payload: z.object({}),
      run: async () => {
        throw new Error("no");
      },
    });
    expect((await runAttempt(once, {}, 1)).outcome).toBe("failed");
  });
});
