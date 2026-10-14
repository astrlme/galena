import { db } from "../db.ts";
import { engine } from "../engine.ts";
import { env } from "../env.ts";
import { fanOut, fanoutPayload } from "../fanout.ts";
import { log } from "../log.ts";
import { defineJob } from "../runner.ts";

/** Who hears about an incident or maintenance event; started by the dispatcher, `fan:{eventId}`. */
export const notifyFanoutJob = defineJob({
  name: "notify.fanout",
  payload: fanoutPayload,
  run: async (event) => {
    const result = await fanOut(event, {
      db,
      url: env.GLN_PAGE_URL,
      sendEmails: (requests) =>
        engine().triggerAll(
          "notify.email",
          requests.map(({ subscriberId, notice }) => ({
            payload: { kind: "notice", subscriberId, notice },
            options: { idempotencyKey: `send:${notice.eventId}:${subscriberId}` },
          })),
        ),
      sendToEndpoints: async (requests) => {
        for (const kind of ["slack", "webhook"] as const) {
          await engine().triggerAll(
            `notify.${kind}`,
            requests
              .filter((r) => r.kind === kind)
              .map(({ endpointId, notice }) => ({
                payload: { endpointId, notice },
                options: { idempotencyKey: `send:${notice.eventId}:${endpointId}` },
              })),
          );
        }
      },
    });
    log.info("notify.fanout", { eventId: event.id, type: event.type, ...result });
    return result;
  },
});
