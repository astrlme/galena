import { expect, test } from "vitest";
import { retryWhileResuming } from "./resume.ts";

const resuming = () =>
  Object.assign(new Error("Aurora is resuming"), { name: "DatabaseResumingException" });

// A fake clock that advances only when the retry sleeps.
function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

test("retries while Aurora resumes, then returns the result", async () => {
  const errors = [resuming(), resuming()];
  let attempts = 0;
  const result = await retryWhileResuming(async () => {
    attempts++;
    const error = errors.shift();
    if (error) throw error;
    return "rows";
  }, fakeTime());
  expect(result).toBe("rows");
  expect(attempts).toBe(3);
});

test("gives up after 30 seconds and rethrows the resume error", async () => {
  const time = fakeTime();
  await expect(
    retryWhileResuming(async () => {
      throw resuming();
    }, time),
  ).rejects.toThrow("Aurora is resuming");
  expect(time.now()).toBeLessThanOrEqual(30_000);
  expect(time.now()).toBeGreaterThanOrEqual(28_000);
});

test("does not retry other errors", async () => {
  let attempts = 0;
  await expect(
    retryWhileResuming(async () => {
      attempts++;
      throw new Error("syntax error at or near SELEC");
    }, fakeTime()),
  ).rejects.toThrow("syntax error");
  expect(attempts).toBe(1);
});
