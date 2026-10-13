import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readSignals } from "./index.ts";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/alertmanager/${name}.json`, import.meta.url), "utf8"),
  );
const firing = fixture("firing");
const partly = fixture("partly-resolved");
const resolved = fixture("resolved");
const instance = (name: string) => ({
  alertname: "HighErrorRate",
  severity: "critical",
  service: "api",
  instance: name,
});

describe("Alertmanager", () => {
  test("a firing group is one signal, starting at its earliest alert", () => {
    const [signal, ...rest] = readSignals("alertmanager", firing) ?? [];
    expect(rest).toEqual([]);
    expect(signal).toEqual({
      source: "alertmanager",
      fingerprint: expect.stringMatching(/^[\w-]{22}$/),
      status: "firing",
      startsAt: "2026-10-13T10:01:00.000Z",
      title: "HighErrorRate",
      alerts: [instance("api-1:9100"), instance("api-2:9100")],
    });
  });

  test("every notification about the group keeps its fingerprint and start", () => {
    const [first, later, last] = [firing, partly, resolved].map(
      (body) => readSignals("alertmanager", body)?.[0],
    );
    expect(later).toMatchObject({ status: "firing", fingerprint: first?.fingerprint });
    expect(last).toMatchObject({
      status: "resolved",
      fingerprint: first?.fingerprint,
      startsAt: first?.startsAt,
    });
  });

  test("another group gets another fingerprint", () => {
    const other = { ...(firing as object), groupKey: '{}:{alertname="DiskFull"}' };
    expect(readSignals("alertmanager", other)?.[0]?.fingerprint).not.toBe(
      readSignals("alertmanager", firing)?.[0]?.fingerprint,
    );
  });

  test("a group of 150 alerts routes on the first 100 and starts at the earliest of all", () => {
    const alerts = Array.from({ length: 150 }, (_, i) => ({
      status: "firing",
      labels: { n: String(i) },
      startsAt: i === 140 ? "2026-10-13T09:00:00Z" : "2026-10-13T10:00:00Z",
    }));
    const [signal] = readSignals("alertmanager", { ...(firing as object), alerts }) ?? [];
    expect(signal?.alerts).toHaveLength(100);
    expect(signal?.startsAt).toBe("2026-10-13T09:00:00.000Z");
  });

  test("labels are cut to 64 per alert, names up to 100 characters and values to 1,000", () => {
    const labels = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`l${i}`, "v"]));
    const alert = {
      status: "firing",
      startsAt: "2026-10-13T10:00:00Z",
      labels: { ["x".repeat(101)]: "dropped", long: "y".repeat(1_500), ...labels },
    };
    const [kept] =
      readSignals("alertmanager", { ...(firing as object), alerts: [alert] })?.[0]?.alerts ?? [];
    expect(Object.keys(kept ?? {})).toHaveLength(64);
    expect(kept?.long).toHaveLength(1_000);
    expect(kept).not.toHaveProperty("x".repeat(101));
  });

  test("a body Alertmanager wouldn't send reads as nothing", () => {
    expect(readSignals("alertmanager", { text: "hello" })).toBeUndefined();
    expect(readSignals("alertmanager", { ...(firing as object), version: "3" })).toBeUndefined();
  });
});

describe("generic JSON", () => {
  const alert = {
    key: "disk-full:db-1",
    status: "firing",
    startsAt: "2026-10-13T12:00:00+02:00",
    labels: { service: "db" },
  };

  test("one alert is one signal named by its key, its start in UTC", () => {
    expect(readSignals("generic", alert)).toEqual([
      {
        source: "generic",
        fingerprint: expect.stringMatching(/^[\w-]{22}$/),
        status: "firing",
        startsAt: "2026-10-13T10:00:00.000Z",
        title: "disk-full:db-1",
        alerts: [{ service: "db" }],
      },
    ]);
  });

  test("a list is one signal per alert, and the same key keeps its fingerprint", () => {
    const signals = readSignals("generic", [
      alert,
      { ...alert, status: "resolved" },
      { ...alert, key: "other", title: "Other" },
    ]);
    expect(signals?.map((s) => s.status)).toEqual(["firing", "resolved", "firing"]);
    expect(signals?.[1]?.fingerprint).toBe(signals?.[0]?.fingerprint);
    expect(signals?.[2]).toMatchObject({ title: "Other" });
    expect(signals?.[2]?.fingerprint).not.toBe(signals?.[0]?.fingerprint);
  });

  test("an Alertmanager body isn't a generic one", () => {
    expect(readSignals("generic", firing)).toBeUndefined();
  });
});
