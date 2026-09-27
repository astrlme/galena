import { type S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { expect, test, vi } from "vitest";
import { createConfigLoader, fetchFromS3 } from "./monitors-file.ts";

const body = (generatedAt: string) => JSON.stringify({ version: 1, generatedAt, monitors: [] });

test("downloads monitors.json once, then only when the ETag changes", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ etag: '"a"', body: body("2026-09-27T10:00:00.000Z") })
    .mockResolvedValueOnce("not_modified")
    .mockResolvedValueOnce({ etag: '"b"', body: body("2026-09-27T10:05:00.000Z") });
  const load = createConfigLoader(fetch);

  const first = await load();
  expect(await load()).toBe(first);
  expect((await load()).generatedAt).toBe("2026-09-27T10:05:00.000Z");
  expect(fetch.mock.calls).toEqual([[undefined], ['"a"'], ['"a"']]);
});

test("a file that doesn't match the contract fails the run instead of checking nothing", async () => {
  const load = createConfigLoader(async () => ({ etag: '"a"', body: '{"version":2}' }));
  await expect(load()).rejects.toThrow();
});

test("S3's 304 means not modified; other errors propagate", async () => {
  const s3Error = (httpStatusCode: number) =>
    new S3ServiceException({
      name: httpStatusCode === 304 ? "NotModified" : "AccessDenied",
      $fault: "client",
      $metadata: { httpStatusCode },
    });
  const send = vi
    .fn()
    .mockResolvedValueOnce({ ETag: '"a"', Body: { transformToString: async () => "{}" } })
    .mockRejectedValueOnce(s3Error(304))
    .mockRejectedValueOnce(s3Error(403));
  const fetch = fetchFromS3(
    { send } as unknown as Pick<S3Client, "send">,
    "bucket",
    "monitors.json",
  );

  expect(await fetch(undefined)).toEqual({ etag: '"a"', body: "{}" });
  expect(await fetch('"a"')).toBe("not_modified");
  await expect(fetch('"a"')).rejects.toBeInstanceOf(S3ServiceException);
  expect(send.mock.calls[1]?.[0].input).toMatchObject({ Bucket: "bucket", IfNoneMatch: '"a"' });
});
