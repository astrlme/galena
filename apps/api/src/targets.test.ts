import { expect, test } from "vitest";
import { targetGuard } from "./targets.ts";

const allows = (stage: "local" | "dev" | "prod", allowLoopback: boolean, url: string) =>
  targetGuard(stage, allowLoopback).checkUrl(url).ok;

test.each(["dev", "prod"] as const)("%s refuses 127.0.0.1 even with the switch on", (stage) => {
  expect(allows(stage, true, "http://127.0.0.1:8080/")).toBe(false);
});

test("local reaches 127.0.0.1 only with the switch on, and nothing else private", () => {
  expect(allows("local", false, "http://127.0.0.1:8080/")).toBe(false);
  expect(allows("local", true, "http://127.0.0.1:8080/")).toBe(true);
  expect(allows("local", true, "http://10.0.0.8/")).toBe(false);
  expect(allows("local", true, "http://169.254.169.254/latest/meta-data/")).toBe(false);
});
