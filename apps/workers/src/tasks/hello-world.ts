import { logger, task } from "@trigger.dev/sdk";

// Smoke test for the trigger.dev connection.
export const helloWorld = task({
  id: "hello.world",
  run: async (payload: { name: string }) => {
    logger.info("hello.world", { name: payload.name });
    return { greeting: `Hello, ${payload.name}` };
  },
});
