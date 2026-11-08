import { listMemberIds } from "@galena/db";
import { lookUpDomains } from "@galena/integrations/rdap";
import { db } from "../db.ts";
import { telemetryDoc } from "../dynamo.ts";
import { engine } from "../engine.ts";
import { env } from "../env.ts";
import { dynamoExpiryStore, scanExpiries } from "../expiry-scan.ts";
import { log } from "../log.ts";
import { readMonitors } from "../monitors-list.ts";
import { cronPayload, defineJob } from "../runner.ts";

const store = dynamoExpiryStore(telemetryDoc, env.GLN_TELEMETRY_TABLE);

/**
 * Hourly, at 25 past: each HTTP monitor's certificate and registered domain, and a warning to
 * every member at 30, 14 and 7 days before one expires. Domains are looked up once a day.
 */
export const expiryScanJob = defineJob({
  name: "expiry.scan",
  payload: cronPayload,
  run: async ({ timestamp }) => {
    const result = await scanExpiries({
      // The schedule's own time, not the clock's: a retried run judges the same hour.
      now: new Date(timestamp),
      store,
      monitors: readMonitors,
      lookUpDomains: (domains) => lookUpDomains(domains),
      members: (workspaceId) => listMemberIds(db, workspaceId),
      warn: (emails) =>
        engine().triggerAll(
          "notify.email",
          emails.map(({ payload, key }) => ({ payload, options: { idempotencyKey: key } })),
        ),
    });
    log.info("expiry.scan", result);
    return result;
  },
});
