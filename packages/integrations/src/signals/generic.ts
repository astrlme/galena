import { type GenericAlert, type Signal, signal } from "@galena/contracts";
import { fingerprint, trimLabels } from "./common.ts";

/** Each generic alert is its own group, named by its `key`. */
export function readGeneric(alert: GenericAlert): Signal {
  return signal.parse({
    source: "generic",
    fingerprint: fingerprint(alert.key),
    status: alert.status,
    startsAt: new Date(alert.startsAt).toISOString(),
    title: alert.title ?? alert.key,
    alerts: [trimLabels(alert.labels)],
  });
}
