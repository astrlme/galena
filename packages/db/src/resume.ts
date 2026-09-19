// The Data API answers DatabaseResumingException while a paused Aurora cluster wakes (~15 s).
// It is a client fault, so the AWS SDK's own retries skip it.
const RESUMING = "DatabaseResumingException";

type Options = {
  timeoutMs?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Runs `attempt`, retrying while Aurora resumes, for up to `timeoutMs` (default 30 s). */
export async function retryWhileResuming<T>(
  attempt: () => Promise<T>,
  {
    timeoutMs = 30_000,
    delayMs = 2_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: Options = {},
): Promise<T> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const resuming = error instanceof Error && error.name === RESUMING;
      if (!resuming || now() + delayMs > deadline) throw error;
      await sleep(delayMs);
    }
  }
}
