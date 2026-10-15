import { crons } from "../jobs/index.ts";
import { cron } from "./shim.ts";

export const rollupUptimeTask = cron(crons.rollupUptime);
