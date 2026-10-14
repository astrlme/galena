import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("only the shim's engine starts runs, so every key goes through globalKey", () => {
  const dir = new URL(".", import.meta.url);
  const starting = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "shim.ts")
    .filter((name) =>
      /tasks\.(?:trigger|batchTrigger)\(/.test(readFileSync(new URL(name, dir), "utf8")),
    );
  expect(starting).toEqual([]);
});
