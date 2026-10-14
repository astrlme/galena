import { incidentAutopilotJob } from "../jobs/incident-autopilot.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const incidentAutopilot = shim(incidentAutopilotJob, { queue: queues.incidents });
