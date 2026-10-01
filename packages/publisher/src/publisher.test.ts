import { snapshot } from "@galena/contracts";
import { describe, expect, test } from "vitest";
import { fixtureSnapshot } from "../test/fixture.ts";
import { badgeSvg, pageFiles } from "./index.ts";

// Golden files: review a diff in test/golden/ like code before updating it (vitest -u).

describe("page files from the fixture workspace", () => {
  const files = pageFiles(fixtureSnapshot());

  test.each(files.map((f) => [f.path, f] as const))(
    "%s matches its golden file",
    async (path, file) => {
      await expect(file.body).toMatchFileSnapshot(`../test/golden/${path}`);
    },
  );

  test("snapshot.json parses back as a snapshot", () => {
    const json = files.find((f) => f.path === "snapshot.json")?.body ?? "";
    expect(snapshot.parse(JSON.parse(json)).snapshotVersion).toBe(7);
  });

  test("the feeds escape markup in titles and never carry raw HTML", () => {
    for (const path of ["feed.rss", "feed.atom"]) {
      const body = files.find((f) => f.path === path)?.body ?? "";
      expect(body).toContain("Errors on &lt;API&gt; &amp; webhooks");
      expect(body).not.toContain("<API>");
    }
  });
});

test("the badge inverts its right half only for a major outage, and grows with its label", () => {
  const calm = badgeSvg("none");
  const major = badgeSvg("critical");
  expect(calm).toContain('fill="#FAFAFA" stroke="#0A0A0A"');
  expect(major).toContain('fill="#0A0A0A" stroke="#0A0A0A"');
  const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1]);
  expect(width(calm)).toBeGreaterThan(width(badgeSvg("critical")));
});
