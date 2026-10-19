import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { expect, test } from "vitest";
import { isApiKey, newApiKey } from "./api-keys.ts";

const keys = appKeys(LOCAL_APP_KEY);
const other = appKeys(Buffer.from("another-deployments-app-key-0000").toString("base64"));

test("only a key this deployment made passes, so a made-up one never reaches the database", () => {
  const { key } = newApiKey(keys);
  expect(key).toMatch(/^gln_[\w-]{54}$/);
  expect(isApiKey(keys, key)).toBe(true);
  // One character off, or made by another deployment, or just the right shape: all refused.
  const flipped = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
  expect(isApiKey(keys, flipped)).toBe(false);
  expect(isApiKey(keys, newApiKey(other).key)).toBe(false);
  expect(isApiKey(keys, `gln_${"x".repeat(54)}`)).toBe(false);
  expect(isApiKey(keys, "gln_short")).toBe(false);
});
