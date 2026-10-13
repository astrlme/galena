import {
  type AlertmanagerPayload,
  MAX_SIGNAL_ALERTS,
  type Signal,
  signal,
} from "@galena/contracts";
import { fingerprint, trimLabels } from "./common.ts";

/**
 * One signal per notification: Alertmanager sends the whole group each time, with the same
 * `groupKey`, and says `resolved` once every alert in it has. Routing sees the first 100 alerts;
 * the start is the earliest of all of them.
 */
export function readAlertmanager(payload: AlertmanagerPayload): Signal {
  const earliest = Math.min(...payload.alerts.map((a) => Date.parse(a.startsAt)));
  return signal.parse({
    source: "alertmanager",
    fingerprint: fingerprint(payload.groupKey),
    status: payload.status,
    startsAt: new Date(earliest).toISOString(),
    title: (payload.commonLabels.alertname ?? "Alert group").slice(0, 200),
    alerts: payload.alerts.slice(0, MAX_SIGNAL_ALERTS).map((a) => trimLabels(a.labels)),
  });
}
