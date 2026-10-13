import { expect, test } from "vitest";
import {
  alertmanagerPayload,
  genericPayload,
  integrationInput,
  integrationUpdate,
  route,
  signal,
  signalIdempotencyKey,
  signalIngest,
} from "./signals.ts";

const ids = {
  integration: "01920000-0000-7000-8000-0000000000b1",
  api: "01920000-0000-7000-8000-000000000011",
  db: "01920000-0000-7000-8000-000000000012",
};

const firing = {
  source: "alertmanager",
  fingerprint: "dGhlLWdyb3VwLWtleQ",
  status: "firing",
  startsAt: "2026-10-13T10:00:00.000Z",
  title: "HighErrorRate",
  alerts: [{ alertname: "HighErrorRate", service: "api" }],
};

test("a signal needs at least one alert and a fingerprint of url-safe characters", () => {
  expect(signal.parse(firing)).toEqual(firing);
  expect(signal.safeParse({ ...firing, alerts: [] }).success).toBe(false);
  expect(signal.safeParse({ ...firing, fingerprint: "a/b" }).success).toBe(false);
  expect(signal.safeParse({ ...firing, status: "pending" }).success).toBe(false);
});

test("a signal carries at most 100 alerts of at most 64 labels", () => {
  expect(signal.safeParse({ ...firing, alerts: Array(101).fill({}) }).success).toBe(false);
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`l${i}`, "v"]));
  expect(signal.safeParse({ ...firing, alerts: [many] }).success).toBe(false);
});

test("a route marks at least one component, each once, major outage unless told", () => {
  expect(route.parse({ match: { service: "api" }, componentIds: [ids.api] })).toEqual({
    match: { service: "api" },
    componentIds: [ids.api],
    downStatus: "major_outage",
  });
  expect(route.safeParse({ match: {}, componentIds: [] }).success).toBe(false);
  expect(route.safeParse({ match: {}, componentIds: [ids.api, ids.api] }).success).toBe(false);
});

test("an integration needs a name and waits for approval unless told", () => {
  expect(integrationInput.parse({ source: "generic", name: " Grafana " })).toEqual({
    source: "generic",
    name: "Grafana",
    publishPolicy: "approve",
    routes: [],
  });
  expect(integrationInput.safeParse({ source: "generic", name: " " }).success).toBe(false);
  expect(integrationInput.safeParse({ source: "sentry", name: "S" }).success).toBe(false);
});

test("an update cannot change the source the hook URL names", () => {
  expect(integrationUpdate.parse({ source: "generic", name: "AM" })).not.toHaveProperty("source");
});

test("the idempotency key names the integration, the group, its status and its start", () => {
  const ingest = signalIngest.parse({
    integrationId: ids.integration,
    tokenIssuedAt: "2026-10-13T09:00:00.000Z",
    signal: firing,
  });
  expect(signalIdempotencyKey(ingest)).toBe(
    "sig:01920000-0000-7000-8000-0000000000b1:dGhlLWdyb3VwLWtleQ:firing:2026-10-13T10:00:00.000Z",
  );
});

test("an Alertmanager body needs version 4, a group key and alerts with RFC 3339 times", () => {
  const body = {
    version: "4",
    groupKey: '{}:{alertname="HighErrorRate"}',
    status: "firing",
    receiver: "galena",
    alerts: [{ status: "firing", labels: {}, startsAt: "2026-10-13T12:00:00.123456789+02:00" }],
  };
  expect(alertmanagerPayload.parse(body)).toEqual({
    version: "4",
    groupKey: '{}:{alertname="HighErrorRate"}',
    status: "firing",
    commonLabels: {},
    alerts: body.alerts,
  });
  expect(alertmanagerPayload.safeParse({ ...body, version: "3" }).success).toBe(false);
  expect(alertmanagerPayload.safeParse({ ...body, alerts: [] }).success).toBe(false);
  const noZone = [{ status: "firing", labels: {}, startsAt: "2026-10-13 12:00" }];
  expect(alertmanagerPayload.safeParse({ ...body, alerts: noZone }).success).toBe(false);
});

test("a generic body is one alert or a list of them", () => {
  const alert = { key: "disk-full", status: "firing", startsAt: "2026-10-13T10:00:00Z" };
  expect(genericPayload.parse(alert)).toEqual([{ ...alert, labels: {} }]);
  expect(genericPayload.parse([alert, alert])).toHaveLength(2);
  expect(genericPayload.safeParse([]).success).toBe(false);
  expect(genericPayload.safeParse({ ...alert, key: "" }).success).toBe(false);
});
