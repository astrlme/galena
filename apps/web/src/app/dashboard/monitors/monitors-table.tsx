"use client";

import { SEVERITY_RANK } from "@galena/core";
import { useState } from "react";
import { Button, buttonClass } from "../../../components/button.tsx";
import { control } from "../../../components/field.tsx";
import { GlyphOnly } from "../../../components/status.tsx";
import {
  columnsFor,
  DataTable,
  type RowSelectionState,
} from "../../../components/ui/data-table.tsx";
import { RowMenu } from "../../../components/ui/row-menu.tsx";
import { Sparkline } from "../../../components/ui/sparkline.tsx";
import { toast } from "../../../components/ui/toast.tsx";
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
    // The URL is in the tooltip, so a row stays one line; search matches it too. A long word
    // (a URL as a name, say) breaks anywhere rather than widening the table.
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

type Filter = "all" | "down" | "degraded" | "paused";
const FILTERS: { value: Filter; label: string; none: string; keep: (r: Row) => boolean }[] = [
  { value: "all", label: "All", none: "No monitors", keep: () => true },
  {
    value: "down",
    label: "Down",
    none: "No monitors are down",
    keep: (r) => r.status === "major_outage" || r.status === "partial_outage",
  },
  {
    value: "degraded",
    label: "Degraded performance",
    none: "No monitors have degraded performance",
    keep: (r) => r.status === "degraded_performance",
  },
  {
    value: "paused",
    label: "Paused",
    none: "No monitors are paused",
    keep: (r) => r.checks === "paused",
  },
];

/**
 * Every monitor as a table: filter by state, search by name or URL, sort by any column, and pause
 * or resume the selected ones together.
 */
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
  /** Resolves whether it worked, so the selection clears only then. */
  onSetEnabled: (ids: string[], enabled: boolean) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [busy, setBusy] = useState<"pause" | "resume">();

  const rows = monitors.map((m) => rowOf(m, telemetry));
  const words = search.trim().toLowerCase();
  const current = FILTERS.find((f) => f.value === filter) ?? FILTERS[0];
  const shown = rows.filter(
    (r) =>
      current?.keep(r) !== false &&
      (!words ||
        r.monitor.name.toLowerCase().includes(words) ||
        r.monitor.http.url.toLowerCase().includes(words)),
  );
  // A filter or search clears the selection, so nothing acts on rows it hides.
  const chosen = shown.filter((r) => selected[r.id]);
  const narrow = (next: { filter?: Filter; search?: string }) => {
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.search !== undefined) setSearch(next.search);
    setSelected({});
  };
  const act = async (enabled: boolean) => {
    const changing = chosen.filter((r) => r.monitor.enabled !== enabled).map((r) => r.id);
    if (changing.length === 0) {
      toast(`The selected monitors are already ${enabled ? "running" : "paused"}.`);
      return;
    }
    setBusy(enabled ? "resume" : "pause");
    if (await onSetEnabled(changing, enabled)) setSelected({});
    setBusy(undefined);
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[14px] font-semibold">Show</legend>
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => narrow({ filter: f.value })}
                className={`${buttonClass("secondary")} min-h-[44px] md:min-h-9 md:py-1 ${filter === f.value ? "border-ink! font-semibold" : ""}`}
              >
                {f.label}{" "}
                <span className="tabular-nums text-slate">{rows.filter(f.keep).length}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex w-full flex-col gap-1 text-[14px] font-semibold sm:ml-auto sm:w-64">
          Search
          <input
            type="search"
            placeholder="Name or URL"
            value={search}
            onChange={(e) => narrow({ search: e.target.value })}
            className={`${control} font-normal placeholder:text-slate`}
          />
        </label>
      </div>
      <p className="sr-only" role="status">
        {chosen.length > 0 ? `${chosen.length} selected` : ""}
      </p>
      {chosen.length > 0 && (
        <section
          aria-label="Selected monitors"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-mist bg-surface px-4 py-2"
        >
          <span className="text-[14px] font-semibold tabular-nums">{chosen.length} selected</span>
          <Button disabled={busy !== undefined} onClick={() => void act(false)}>
            {busy === "pause" ? "Pausing…" : "Pause"}
          </Button>
          <Button disabled={busy !== undefined} onClick={() => void act(true)}>
            {busy === "resume" ? "Resuming…" : "Resume"}
          </Button>
          <Button variant="quiet" onClick={() => setSelected({})}>
            Clear
          </Button>
        </section>
      )}
      {shown.length === 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-mist bg-surface px-4 py-3 text-[14px]">
          <span>
            {current?.none}
            {words ? ` matching "${search.trim()}"` : ""}.
          </span>
          <Button variant="quiet" onClick={() => narrow({ filter: "all", search: "" })}>
            Show all monitors
          </Button>
        </div>
      ) : (
        <DataTable
          label="Monitors"
          data={shown}
          columns={columns}
          selection={{
            selected: Object.fromEntries(chosen.map((r) => [r.id, true])),
            onChange: setSelected,
            nameOf: (r) => r.monitor.name,
          }}
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
      )}
    </>
  );
}
