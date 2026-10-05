import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { fanOut, fanoutPayload } from "../fanout.ts";
import { globalKey } from "./keys.ts";

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
            await Promise.all(
              requests.slice(i, i + BATCH).map(async ({ subscriberId, notice }) => ({
                payload: { kind: "notice", subscriberId, notice },
                options: {
                  idempotencyKey: await globalKey(`send:${notice.eventId}:${subscriberId}`),
                },
              })),
            ),
          );
        }
      },
      sendToEndpoints: async (requests) => {
        for (const kind of ["slack", "webhook"] as const) {
          const mine = requests.filter((r) => r.kind === kind);
          for (let i = 0; i < mine.length; i += BATCH) {
            await tasks.batchTrigger(
              `notify.${kind}`,
              await Promise.all(
                mine.slice(i, i + BATCH).map(async ({ endpointId, notice }) => ({
                  payload: { endpointId, notice },
                  options: {
                    idempotencyKey: await globalKey(`send:${notice.eventId}:${endpointId}`),
                    // One delivery at a time per destination, so a slow one throttles only itself.
                    concurrencyKey: `${kind}:${endpointId}`,
                  },
                })),
              ),
            );
          }
        }
      },
    });
    logger.info("notify.fanout", { eventId: event.id, type: event.type, ...result });
    return result;
  },
});
