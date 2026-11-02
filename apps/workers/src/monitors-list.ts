import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type MonitorsFile, monitorsFile } from "@galena/contracts";
import { monitorsFileFromS3 } from "@galena/integrations/config";
import { env } from "./env.ts";
import { type MonitorToRoll, toRoll } from "./telemetry-rollup.ts";

const fromS3 = env.GLN_CONFIG_BUCKET
  ? monitorsFileFromS3({
      region: env.GLN_HOME_REGION,
      bucket: env.GLN_CONFIG_BUCKET,
      key: env.GLN_CONFIG_KEY,
    })
  : undefined;

/** Locally the file `outbox.dispatch` writes to the config folder; none yet means no monitors. */
async function readLocal(): Promise<MonitorsFile["monitors"]> {
  try {
    const text = await readFile(resolve(env.GLN_CONFIG_DIR, "monitors.json"), "utf8");
    return monitorsFile.parse(JSON.parse(text)).monitors;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** The enabled monitors and their quorum, from `monitors.json`: no Aurora read. */
export async function monitorsToRoll(): Promise<MonitorToRoll[]> {
  return toRoll(fromS3 ? await fromS3() : { monitors: await readLocal() });
}
