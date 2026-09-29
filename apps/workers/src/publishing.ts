import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { buildSnapshot, type Clock } from "@galena/core";
import {
  advancePageVersion,
  type Db,
  ensurePage,
  loadSnapshotInputs,
  nextSnapshotVersion,
} from "@galena/db";
import { type PageFile, pageFiles } from "@galena/publisher";
import { z } from "zod";

// Readers may keep a file 15 s; CloudFront keeps serving the last one for a day if S3 fails.
const DATA_CACHE_CONTROL = "public, max-age=15, stale-while-revalidate=60, stale-if-error=86400";

/** Where a page's files go; paths are relative to the page's root. */
export type PageStore = { write: (slug: string, files: readonly PageFile[]) => Promise<void> };

export const publishPayload = z.object({ version: z.int().min(1) });
export type PublishPayload = z.infer<typeof publishPayload>;

export type PublishDeps = { db: Db; clock: Clock; store: PageStore; url: string };
export type PublishOutcome = "no_page" | "superseded" | "published";

/**
 * Writes the page's data files. `version` was taken after the change that asked for this run
 * had committed; once a publish that read the database later is out, this run has nothing to
 * add and stops. Otherwise it takes a new version before reading, so the version it publishes
 * covers every change committed before the read.
 */
export async function publishPage(
  { version }: PublishPayload,
  deps: PublishDeps,
): Promise<{ outcome: PublishOutcome; published?: number }> {
  const target = await ensurePage(deps.db);
  if (!target) return { outcome: "no_page" };
  if (target.publishedVersion >= version) return { outcome: "superseded" };
  const current = await nextSnapshotVersion(deps.db);
  const inputs = await loadSnapshotInputs(deps.db, target, {
    snapshotVersion: current,
    url: deps.url,
    now: deps.clock.now(),
  });
  await deps.store.write(target.slug, pageFiles(buildSnapshot(inputs, deps.clock)));
  // Runs of this task queue one at a time, so nothing newer went out while this one wrote.
  await advancePageVersion(deps.db, target.id, "data", current);
  return { outcome: "published", published: current };
}

/** Local development: files under `dir/<slug>/`, each replaced whole. */
export function localPageStore(dir: string): PageStore {
  return {
    async write(slug, files) {
      for (const file of files) {
        const path = resolve(dir, slug, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, file.body);
        await rename(`${path}.tmp`, path);
      }
    },
  };
}

/** AWS stages: the primary page bucket under `pages/<slug>/`; replication copies it on. */
export function s3PageStore(options: { region: string; bucket: string }): PageStore {
  const s3 = new S3Client({ region: options.region });
  return {
    async write(slug, files) {
      await Promise.all(
        files.map((file) =>
          s3.send(
            new PutObjectCommand({
              Bucket: options.bucket,
              Key: `pages/${slug}/${file.path}`,
              Body: file.body,
              ContentType: file.contentType,
              CacheControl: DATA_CACHE_CONTROL,
            }),
          ),
        ),
      );
    },
  };
}
