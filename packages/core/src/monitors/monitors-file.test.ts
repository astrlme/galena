import { type MonitorConfig, monitorConfig, monitorsFile } from "@galena/contracts";
import { expect, test } from "vitest";
import { fixedClock } from "../ports.ts";
import { buildMonitorsFile } from "./monitors-file.ts";

const monitor = (id: string, overrides: Partial<MonitorConfig> = {}) =>
  monitorConfig.parse({
    id,
    workspaceId: "01920000-0000-7000-8000-000000000001",
    componentId: null,
    name: `Monitor ${id.slice(-2)}`,
    type: "http",
    http: { url: "https://example.com/health", keyword: "ok" },
    publishPolicy: "auto",
    ...overrides,
  });

test("lists enabled monitors only, sorted by id, with what probes and the evaluator need", () => {
  const b = monitor("01920000-0000-7000-8000-0000000000b2");
  const a = monitor("01920000-0000-7000-8000-0000000000a1");
  const off = monitor("01920000-0000-7000-8000-0000000000c3", { enabled: false });
  const file = buildMonitorsFile([b, off, a], fixedClock("2026-09-27T10:00:00.000Z"));

  expect(monitorsFile.parse(file)).toEqual(file);
  expect(file.generatedAt).toBe("2026-09-27T10:00:00.000Z");
  expect(file.monitors.map((m) => m.id)).toEqual([a.id, b.id]);
  // Names and publish policies stay in Postgres: the file carries only what checks need.
  expect(Object.keys(file.monitors[0] ?? {}).sort()).toEqual([
    "detection",
    "downStatus",
    "http",
    "id",
    "maintenance",
    "type",
    "workspaceId",
  ]);
});

test("a monitor carries the maintenance windows covering its component, and only those", () => {
  const api = "01920000-0000-7000-8000-000000000011";
  const onApi = monitor("01920000-0000-7000-8000-0000000000a1", { componentId: api as never });
  const elsewhere = monitor("01920000-0000-7000-8000-0000000000b2");
  const window = {
    componentIds: [api],
    startsAt: new Date("2026-09-29T22:00:00.000Z"),
    endsAt: new Date("2026-09-29T23:00:00.000Z"),
  };
  const file = buildMonitorsFile([onApi, elsewhere], fixedClock("2026-09-29T10:00:00.000Z"), [
    window,
  ]);
  expect(file.monitors.map((m) => m.maintenance)).toEqual([
    [{ startsAt: "2026-09-29T22:00:00.000Z", endsAt: "2026-09-29T23:00:00.000Z" }],
    [],
  ]);
});

test("a monitors.json written before windows existed still parses, with none", () => {
  const old = buildMonitorsFile(
    [monitor("01920000-0000-7000-8000-0000000000a1")],
    fixedClock("2026-09-27T10:00:00.000Z"),
  );
  const { maintenance: _, ...withoutWindows } = old.monitors[0] ?? {};
  const parsed = monitorsFile.parse({ ...old, monitors: [withoutWindows] });
  expect(parsed.monitors[0]?.maintenance).toEqual([]);
});
