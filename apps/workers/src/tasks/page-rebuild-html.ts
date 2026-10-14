import { pageRebuildHtmlJob } from "../jobs/page-rebuild-html.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

// Vite and Astro need more memory than the smallest machine has.
export const pageRebuildHtml = shim(pageRebuildHtmlJob, {
  queue: queues.builder,
  machine: "small-2x",
});
