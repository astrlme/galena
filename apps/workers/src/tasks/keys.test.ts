import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("every trigger inside a task keys through globalKey", () => {
  const dir = new URL(".", import.meta.url);
  const plain = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap((name) =>
      readFileSync(new URL(name, dir), "utf8")
        .split("\n")
        .filter((line) => /idempotencyKey:/.test(line) && !/globalKey\(|approve:/.test(line))
        .map((line) => `${name}: ${line.trim()}`),
    );
  expect(plain).toEqual([]);
});
