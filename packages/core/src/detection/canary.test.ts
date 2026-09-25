import { expect, test } from "vitest";
import { type CanaryTrack, nextCanary } from "./canary.ts";

const included: CanaryTrack = { excluded: false, passes: 0 };

test("a failed canary excludes its region at once", () => {
  expect(nextCanary(included, false)).toEqual({ excluded: true, passes: 0 });
});

test("an excluded region returns only after three passes in a row", () => {
  let track = nextCanary(included, false);
  track = nextCanary(track, true);
  track = nextCanary(track, true);
  expect(track.excluded).toBe(true);
  expect(nextCanary(track, true).excluded).toBe(false);
  expect(nextCanary(nextCanary(track, false), true).excluded).toBe(true);
});

test("passes keep an included region included", () => {
  expect(nextCanary(included, true)).toEqual({ excluded: false, passes: 1 });
});
