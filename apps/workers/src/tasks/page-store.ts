import { env } from "../env.ts";
import { localNoteFile, localPageStore, s3NoteFile, s3PageStore } from "../publishing.ts";

/** The primary page bucket in AWS stages, a folder on disk locally. */
export const pageStore = env.GLN_PAGE_BUCKET
  ? s3PageStore({ region: env.GLN_PAGE_REGION, bucket: env.GLN_PAGE_BUCKET })
  : localPageStore(env.GLN_PAGE_DIR);

/** `page.publish` writes the note on each publish; `page.heartbeat` reads it. */
export const noteFile = env.GLN_CONFIG_BUCKET
  ? s3NoteFile({ region: env.GLN_HOME_REGION, bucket: env.GLN_CONFIG_BUCKET })
  : localNoteFile(env.GLN_CONFIG_DIR);
