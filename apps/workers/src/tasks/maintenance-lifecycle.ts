import { maintenanceLifecycleJob } from "../jobs/maintenance-lifecycle.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const maintenanceLifecycle = shim(maintenanceLifecycleJob, { queue: queues.maintenance });
