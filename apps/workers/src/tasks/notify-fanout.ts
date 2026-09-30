import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { fanOut, fanoutPayload } from "../fanout.ts";

const notify = queue({ name: "notify", concurrencyLimit: 5 });
// trigger.dev takes up to this many runs per batch call.
const BATCH = 500;

/** Who hears about an incident or maintenance event; started by the dispatcher, `fan:{eventId}`. */
export const notifyFanout = task({
  id: "notify.fanout",
  queue: notify,
  run: async (payload: unknown) => {
    const event = fanoutPayload.parse(payload);
    const result = await fanOut(event, {
      db,
      url: env.GLN_PAGE_URL,
      sendEmails: async (requests) => {
        for (let i = 0; i < requests.length; i += BATCH) {
          await tasks.batchTrigger(
            "notify.email",
            requests.slice(i, i + BATCH).map(({ subscriberId, notice }) => ({
              payload: { kind: "notice", subscriberId, notice },
              options: { idempotencyKey: `send:${notice.eventId}:${subscriberId}` },
            })),
          );
        }
      },
    });
    logger.info("notify.fanout", { eventId: event.id, type: event.type, ...result });
    return result;
  },
});
