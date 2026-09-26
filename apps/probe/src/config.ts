import { GetObjectCommand, type S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { type MonitorsFile, monitorsFile } from "@galena/contracts";

type Fetched = { etag: string; body: string } | "not_modified";

/**
 * `monitors.json`, kept in memory between invocations: a warm Lambda sends the ETag it holds
 * and downloads the file again only when it changed.
 */
export function createConfigLoader(fetch: (etag: string | undefined) => Promise<Fetched>) {
  let cached: { etag: string; file: MonitorsFile } | undefined;
  return async (): Promise<MonitorsFile> => {
    const fetched = await fetch(cached?.etag);
    if (fetched !== "not_modified") {
      cached = { etag: fetched.etag, file: monitorsFile.parse(JSON.parse(fetched.body)) };
    }
    if (!cached) throw new Error("S3 answered 304 to a request that sent no ETag.");
    return cached.file;
  };
}

export function fetchFromS3(s3: Pick<S3Client, "send">, bucket: string, key: string) {
  return async (etag: string | undefined): Promise<Fetched> => {
    try {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: etag }),
      );
      return { etag: object.ETag ?? "", body: (await object.Body?.transformToString()) ?? "" };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 304) {
        return "not_modified";
      }
      throw error;
    }
  };
}
