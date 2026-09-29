import { env } from "../env.ts";
import { localPageStore, s3PageStore } from "../publishing.ts";

/** The primary page bucket in AWS stages, a folder on disk locally. */
export const pageStore = env.GLN_PAGE_BUCKET
  ? s3PageStore({ region: env.GLN_PAGE_REGION, bucket: env.GLN_PAGE_BUCKET })
  : localPageStore(env.GLN_PAGE_DIR);
