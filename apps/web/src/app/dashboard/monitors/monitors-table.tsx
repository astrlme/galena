"use client";

import { SEVERITY_RANK } from "@galena/core";
import { GlyphOnly } from "../../../components/status.tsx";
import { columnsFor, DataTable } from "../../../components/ui/data-table.tsx";
import { RowMenu } from "../../../components/ui/row-menu.tsx";
import { Sparkline } from "../../../components/ui/sparkline.tsx";
import type { Monitor } from "./monitor-form.tsx";
import { ago, latency, percent, type Row, regionState, rowOf, uptimeOf } from "./monitor-row.ts";
import type { Reading } from "./telemetry.tsx";

/** A cell without a value says why: paused, check results not read yet, or none. */
function Missing({ row }: { row: Row }) {
  const why =
    row.checks === "paused"
      ? "Paused"
      : row.checks === "loading"
        ? "Loading check results"
        : "No data";
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{why}</span>
    </>
  );
}

// Missing values sort last whichever way a column sorts.
const last = { sortFn: "basic", sortUndefined: "last" } as const;
const col = columnsFor<Row>();
const columns = col.columns([
  col.accessor(
    (r) => (r.checks === "read" ? (r.status ? SEVERITY_RANK[r.status] : -1) : undefined),
    {
      id: "state",
      header: "State",
      ...last,
      cell: ({ row: { original: r } }) =>
        r.checks === "paused" ? (
          <span className="text-slate">Paused</span>
        ) : r.checks === "loading" ? (
          <Missing row={r} />
        ) : (
          <GlyphOnly status={r.status} />
        ),
    },
  ),
  col.accessor((r) => r.monitor.name, {
    id: "name",
    header: "Name",
    sortFn: "text",
    // The URL is in the tooltip, so a row stays one line. A long word (a URL as a name, say)
    // breaks anywhere rather than widening the table.
    cell: ({ row: { original: r } }) => (
      <span className="font-semibold [overflow-wrap:anywhere]" title={r.monitor.http.url}>
        {r.monitor.name}
      </span>
    ),
  }),
  col.display({
    id: "type",
    header: "Type",
    cell: () => "HTTP",
    meta: { className: "hidden @5xl:table-cell" },
  }),
  col.display({
    id: "day",
    header: "24 h median",
    cell: ({ row: { original: r } }) => {
      const medians = r.summary?.hourlyMedianMs ?? [];
      const known = medians.filter((v): v is number => v !== null);
      if (known.length === 0) return <Missing row={r} />;
      const label = `Median answer time over the last 24 hours, by hour: ${latency(Math.min(...known))} to ${latency(Math.max(...known))}`;
      return <Sparkline values={medians} label={label} />;
    },
    meta: { className: "hidden @4xl:table-cell" },
  }),
  col.accessor((r) => uptimeOf(r.summary), {
    id: "uptime",
    header: "30 d uptime",
    ...last,
    cell: ({ getValue, row: { original: r } }) => {
      const share = getValue();
      return share === undefined ? <Missing row={r} /> : percent(share);
    },
    meta: { className: "hidden text-right tabular-nums @md:table-cell" },
  }),
  col.accessor((r) => r.summary?.p95Ms ?? undefined, {
    id: "p95",
    header: "24 h p95",
    ...last,
    cell: ({ getValue, row: { original: r } }) => {
      const p95 = getValue();
      return p95 === undefined ? <Missing row={r} /> : latency(p95);
    },
    meta: { className: "hidden text-right tabular-nums @4xl:table-cell" },
  }),
  col.display({
    id: "regions",
    header: "Regions",
    cell: ({ row: { original: r } }) =>
      r.regions.length === 0 ? (
        <Missing row={r} />
      ) : (
        <span className="flex gap-1.5">
          {r.regions.map(({ region, result }) => {
            const { status, label } = regionState(region, result);
            return <GlyphOnly key={region} status={status} label={label} />;
          })}
        </span>
      ),
    meta: { className: "hidden @2xl:table-cell" },
  }),
  col.accessor((r) => (r.lastCheck ? Date.parse(r.lastCheck) : undefined), {
    id: "lastCheck",
    header: "Last check",
    ...last,
    cell: ({ row: { original: r } }) =>
      r.lastCheck ? (
        <time dateTime={r.lastCheck} title={new Date(r.lastCheck).toLocaleString()}>
          {ago(r.lastCheck, Date.now())}
        </time>
      ) : (
        <Missing row={r} />
      ),
    meta: { className: "hidden whitespace-nowrap tabular-nums @3xl:table-cell" },
  }),
]);

/** Every monitor as a table, sorted by any column. */
export function MonitorsTable({
  monitors,
  telemetry,
  onEdit,
  onDelete,
  onSetEnabled,
}: {
  monitors: Monitor[];
  telemetry: { regions: string[]; monitors: Reading[] } | undefined;
  onEdit: (monitor: Monitor) => void;
  onDelete: (monitor: Monitor) => void;
  onSetEnabled: (ids: string[], enabled: boolean) => Promise<boolean>;
}) {
  return (
    <DataTable
      label="Monitors"
      data={monitors.map((m) => rowOf(m, telemetry))}
      columns={columns}
      actions={(r) => (
        <RowMenu
          name={r.monitor.name}
          actions={[
            { label: "Edit", isEdit: true, onSelect: () => onEdit(r.monitor) },
            {
              label: r.monitor.enabled ? "Pause" : "Resume",
              onSelect: () => void onSetEnabled([r.id], !r.monitor.enabled),
            },
            { label: "Delete", destructive: true, onSelect: () => onDelete(r.monitor) },
          ]}
        />
      )}
    />
  );
}
