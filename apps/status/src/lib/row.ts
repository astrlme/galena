import type { SnapshotComponent } from "@galena/contracts";
import { componentStatusLabels } from "@galena/contracts/copy";
import type { GlyphName } from "@galena/ui/tokens";

type Row = Pick<SnapshotComponent, "status" | "observed">;

/** What a component's row shows: its status, or no data while nothing reports on it. */
export const rowState = (c: Row): GlyphName => (c.observed === false ? "no_data" : c.status);

export const rowLabel = (c: Row): string =>
  c.observed === false ? "No data" : componentStatusLabels[c.status];
