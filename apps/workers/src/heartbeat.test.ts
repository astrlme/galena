import { readFile } from "node:fs/promises";
import { type MonitorId, monitorId } from "@galena/contracts";
import { fixedClock } from "@galena/core";
import { beforeEach, expect, test } from "vitest";
import { beat } from "./heartbeat.ts";
import type { PageStore, PublishedNote, StoredFile } from "./publishing.ts";
import type { DetectedState } from "./states.ts";

const golden = await readFile(
  new URL("../../../packages/publisher/test/golden/snapshot.json", import.meta.url),
  "utf8",
);
const clock = fixedClock("2026-09-29T14:35:00.000Z");
const minutesAgo = (m: number) => clock.now().getTime() - m * 60_000;
const probe = monitorId.parse("01920000-0000-7000-8000-00000000000a");
// The golden page is snapshot 7; it showed the probe on its third transition.
const note: PublishedNote = {
  version: 1,
  slug: "status",
  snapshotVersion: 7,
  monitors: { [probe]: 3 },
};

let files: Map<string, string>;
let written: StoredFile[];
let rollups: number;
let reads: MonitorId[][];

beforeEach(() => {
  files = new Map([["status/snapshot.json", golden]]);
  written = [];
  rollups = 0;
  reads = [];
});

const store: PageStore = {
  read: async (slug, path) => files.get(`${slug}/${path}`),
  write: async (_slug, batch) => void written.push(...batch),
};
// `null`: no note at all (an explicit undefined would take the default).
const run = (detected: [MonitorId, DetectedState][], stored: PublishedNote | null = note) =>
  beat({
    clock,
    store,
    note: { read: async () => stored ?? undefined, write: async () => {} },
    readStates: async (ids) => {
      reads.push([...ids]);
      return new Map(detected);
    },
    rollup: async () => void rollups++,
  });

test("stamps the page as confirmed when it still shows what detection holds, changing nothing else", async () => {
  const plan = await run([[probe, { state: "up", transitionSeq: 3, enteredAt: minutesAgo(600) }]]);
  expect(plan).toEqual({ action: "confirm" });
  expect(reads).toEqual([[probe]]);
  expect(written.map((f) => [f.path, f.contentType])).toEqual([
    ["snapshot.json", "application/json"],
  ]);
  const before = JSON.parse(golden);
  const after = JSON.parse(String(written[0]?.body));
  expect(after).toEqual({ ...before, publishedAt: "2026-09-29T14:35:00.000Z" });
  expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(rollups).toBe(0);
});

test("runs the rollup when detection moved on and the page never caught up", async () => {
  const plan = await run([[probe, { state: "down", transitionSeq: 4, enteredAt: minutesAgo(30) }]]);
  expect(plan).toEqual({ action: "rollup", reason: "behind" });
  expect(rollups).toBe(1);
  expect(written).toEqual([]);
});

test("leaves the page alone while a transition is still on its way", async () => {
  const plan = await run([[probe, { state: "down", transitionSeq: 4, enteredAt: minutesAgo(2) }]]);
  expect(plan).toEqual({ action: "wait", monitorId: probe });
  expect(rollups).toBe(0);
  expect(written).toEqual([]);
});

test("runs the rollup with no note to go on, or when the page's file can't be read", async () => {
  expect(await run([], null)).toEqual({ action: "rollup", reason: "no_record" });
  expect(reads).toEqual([]);
  files.set("status/snapshot.json", "{half a file");
  expect(await run([])).toEqual({ action: "rollup", reason: "other_snapshot" });
  expect(rollups).toBe(2);
  expect(written).toEqual([]);
});
