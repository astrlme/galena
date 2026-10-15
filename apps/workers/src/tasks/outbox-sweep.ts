import { crons } from "../jobs/index.ts";
import { cron } from "./shim.ts";

export const outboxSweep = cron(crons.outboxSweep);
