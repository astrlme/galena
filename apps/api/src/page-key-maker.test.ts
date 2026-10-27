import { createPublicKey } from "node:crypto";
import { expect, test } from "vitest";
import { keyMaker } from "./page-key-maker.ts";

const NAME = "/galena/dev/page-signing-key-1";

const memoryStore = () => {
  const keys = new Map<string, string>();
  const created: string[] = [];
  return {
    keys,
    created,
    store: {
      read: async (name: string) => keys.get(name),
      create: async (name: string, privateKey: string) => {
        keys.set(name, privateKey);
        created.push(name);
      },
    },
  };
};
const event = (RequestType: "Create" | "Update") => ({
  RequestType,
  ResourceProperties: { ParameterName: NAME },
});
const publicHalf = (privateKey: string) =>
  createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();

test("the first deploy makes a key, keeps the private half and hands CloudFront the public one", async () => {
  const { keys, created, store } = memoryStore();
  const result = await keyMaker(store)(event("Create"));
  expect(created).toEqual([NAME]);
  const privateKey = keys.get(NAME) ?? "";
  expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  expect(result).toEqual({ PhysicalResourceId: NAME, Data: { PublicKey: publicHalf(privateKey) } });
});

test("later deploys hand back the same public key and make nothing", async () => {
  const { keys, created, store } = memoryStore();
  await keyMaker(store)(event("Create"));
  const first = keys.get(NAME) ?? "";
  created.length = 0;
  for (const type of ["Create", "Update"] as const) {
    expect(await keyMaker(store)(event(type))).toEqual({
      PhysicalResourceId: NAME,
      Data: { PublicKey: publicHalf(first) },
    });
  }
  expect(created).toEqual([]);
});

test("a key lost after the first deploy stops the deploy with the fix, not a new key", async () => {
  // CloudFront can't take a new public key in place, so a new pair here would fail later anyway.
  const { created, store } = memoryStore();
  await expect(keyMaker(store)(event("Update"))).rejects.toThrow(/pageKeyGeneration/);
  expect(created).toEqual([]);
});

test("deleting the resource leaves the key alone", async () => {
  const { keys, store } = memoryStore();
  keys.set(NAME, "kept");
  const result = await keyMaker(store)({
    RequestType: "Delete",
    PhysicalResourceId: NAME,
    ResourceProperties: { ParameterName: NAME },
  });
  expect(result).toEqual({ PhysicalResourceId: NAME });
  expect(keys.get(NAME)).toBe("kept");
});
