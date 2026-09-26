import type { LookupAddress } from "node:dns";
import { describe, expect, test } from "vitest";
import { BlockedByGuardError, createGuard, guard, isPublicAddress } from "./ssrf.ts";

describe("isPublicAddress", () => {
  test.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.0",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "11.0.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "100.128.0.1",
    "::ffff:8.8.8.8",
    "2606:4700:4700::1111",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("checkUrl", () => {
  test.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "javascript:alert(1)",
    "http://127.0.0.1/",
    "http://127.0.0.1.:8080/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "https://user:secret@example.com/",
    "not a url",
  ])("refuses %s", (url) => {
    const result = guard.checkUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("blocked_by_guard");
  });

  test.each(["https://example.com/health", "http://example.com:8080/", "https://8.8.8.8/"])(
    "allows %s",
    (url) => {
      expect(guard.checkUrl(url).ok).toBe(true);
    },
  );

  test("resolves a relative redirect against the page it came from", () => {
    const result = guard.checkUrl("/next", "https://example.com/a/b");
    expect(result.ok && result.value.href).toBe("https://example.com/next");
  });
});

describe("lookup", () => {
  const answers: Record<string, string[]> = {
    "public.test": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    "mixed.test": ["93.184.215.14", "10.0.0.1"],
    "metadata.test": ["169.254.169.254"],
  };
  const guarded = createGuard({
    resolve: (hostname, _options, callback) =>
      callback(
        null,
        (answers[hostname] ?? []).map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      ),
  });
  const lookup = (hostname: string, all: boolean) =>
    new Promise<string | LookupAddress[]>((resolve, reject) =>
      guarded.lookup(hostname, { all }, (error, address) =>
        error ? reject(error) : resolve(address),
      ),
    );

  test("passes public answers through, one or all", async () => {
    expect(await lookup("public.test", false)).toBe("93.184.215.14");
    expect(await lookup("public.test", true)).toHaveLength(2);
  });

  test.each(["mixed.test", "metadata.test", "nothing.test"])(
    "refuses %s, so the socket never connects",
    async (hostname) => {
      await expect(lookup(hostname, false)).rejects.toBeInstanceOf(BlockedByGuardError);
      await expect(lookup(hostname, true)).rejects.toBeInstanceOf(BlockedByGuardError);
    },
  );
});
