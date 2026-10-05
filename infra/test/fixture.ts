import { fileURLToPath } from "node:url";
import { loadConfig, stageSchema } from "../config/stages.ts";

/** A deployment with every option set and example names: what most infra tests build. */
export const fixture = loadConfig(fileURLToPath(new URL("fixture.config.json", import.meta.url)));

/** A second deployment with only what's required: no domains, no GitHub, data kept. */
export const plain = stageSchema.parse({
  stage: "prod",
  homeRegion: fixture.homeRegion,
  probeRegions: fixture.probeRegions,
  pageRegions: fixture.pageRegions,
  telemetryCapacity: { read: 20, write: 20 },
  auroraMaxAcu: 4,
});
