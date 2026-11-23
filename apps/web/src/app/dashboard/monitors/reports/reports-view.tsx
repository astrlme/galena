"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonClass } from "../../../../components/button.tsx";
import { columnsFor, DataTable } from "../../../../components/ui/data-table.tsx";
import { EmptyState } from "../../../../components/ui/empty-state.tsx";
import { Loading } from "../../../../components/ui/loading.tsx";
import { Select } from "../../../../components/ui/select.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import { hm } from "../../../../lib/time.ts";
import { latency, percent } from "../monitor-row.ts";
import { budgetText, monthsBefore, reportCsv, type UptimeReport } from "./report.ts";

type MonitorMonth = UptimeReport["monitors"][number];
type ComponentMonth = UptimeReport["components"][number];

// Daily rollups are kept 400 days: this month and the twelve before it.
const MONTHS = 13;

const shareUp = (r: { minutes: number; minutesDown: number }) =>
  r.minutes === 0 ? undefined : 1 - r.minutesDown / r.minutes;
const last = { sortFn: "basic", sortUndefined: "last" } as const;
const none = (words: string) => <span className="text-slate">{words}</span>;
const uptimeCell = ({ getValue }: { getValue: () => number | undefined }) => {
  const value = getValue();
  return value === undefined ? none("No data") : percent(value);
};

const mon = columnsFor<MonitorMonth>();
const MONITOR_COLUMNS = mon.columns([
  mon.accessor("name", {
    header: "Monitor",
    cell: ({ row: { original: m } }) => (
      <Link href={`/dashboard/monitors/view/?id=${m.id}`} className="hover:underline">
        {m.name}
      </Link>
    ),
  }),
  mon.accessor(shareUp, {
    id: "uptime",
    header: "Uptime",
    ...last,
    cell: uptimeCell,
    meta: { className: "text-right tabular-nums" },
  }),
  mon.accessor("minutesDown", {
    header: "Down",
    cell: ({ getValue }) => hm(getValue()),
    meta: { className: "hidden text-right tabular-nums @lg:table-cell" },
  }),
  mon.accessor("incidents", {
    header: "Incidents",
    meta: { className: "hidden text-right tabular-nums @lg:table-cell" },
  }),
  mon.accessor((m) => m.p95Ms ?? undefined, {
    id: "p95",
    header: "p95",
    ...last,
    cell: ({ getValue }) => {
      const p95 = getValue();
      return p95 === undefined ? none("No data") : latency(p95);
    },
    meta: { className: "hidden text-right tabular-nums @2xl:table-cell" },
  }),
  mon.accessor((m) => m.slaTarget ?? undefined, {
    id: "target",
    header: "SLA target",
    ...last,
    cell: ({ getValue }) => {
      const target = getValue();
      return target === undefined ? none("None") : `${target}%`;
    },
    meta: { className: "hidden text-right tabular-nums @xl:table-cell" },
  }),
  mon.accessor((m) => m.budget?.leftMinutes, {
    id: "budget",
    header: "Error budget",
    ...last,
    cell: ({ row: { original: m } }) =>
      m.budget === null ? (
        none("None")
      ) : (
        <span className={m.budget.leftMinutes < 0 ? "font-semibold" : undefined}>
          {budgetText(m.budget)}
        </span>
      ),
    meta: { className: "hidden text-right tabular-nums @md:table-cell" },
  }),
]);

const com = columnsFor<ComponentMonth>();
const COMPONENT_COLUMNS = com.columns([
  com.accessor("name", { header: "Component" }),
  com.accessor(shareUp, {
    id: "uptime",
    header: "Uptime",
    ...last,
    cell: uptimeCell,
    meta: { className: "text-right tabular-nums" },
  }),
  com.accessor("minutesDown", {
    header: "Down",
    cell: ({ getValue }) => hm(getValue()),
    meta: { className: "hidden text-right tabular-nums @md:table-cell" },
  }),
  com.accessor("incidents", {
    header: "Incidents",
    meta: { className: "hidden text-right tabular-nums @lg:table-cell" },
  }),
]);

/** Hands the browser the report as a file. */
function download(report: UptimeReport) {
  const url = URL.createObjectURL(new Blob([reportCsv(report)], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `uptime-${report.month}.csv`;
  link.click();
  // Revoked once the click has handed the file over; some browsers cancel it if done at once.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ReportsView() {
  const [months] = useState(() => monthsBefore(new Date(), MONTHS));
  const [month, setMonth] = useState(months[0]?.value ?? "");
  const label = months.find((m) => m.value === month)?.label;
  const report = useQuery({
    queryKey: ["reports", "uptime", month],
    queryFn: () => unwrap(api.GET("/v1/reports/uptime", { params: { query: { month } } })),
  });

  return (
    <>
      <Link
        href="/dashboard/monitors/"
        className="text-[14px] text-slate hover:underline active:underline"
      >
        Monitors
      </Link>
      <h1 className="mt-1 text-[24px] font-semibold leading-[1.25]">Uptime reports</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Each month in UTC. A monitor's minute is down when at least two regions agree, maintenance
        or not; a component counts what its status page showed, so maintenance counts as up. The
        running month counts up to the last whole hour.
      </p>
      <div className="mt-6 flex flex-wrap items-end gap-4">
        <div className="w-56">
          <Select label="Month" value={month} onChange={setMonth} options={months} />
        </div>
        <Button
          variant="secondary"
          disabled={!report.isSuccess}
          onClick={() => report.data && download(report.data)}
        >
          Download CSV
        </Button>
      </div>
      {report.isPending ? (
        <Loading label="Loading report" table />
      ) : report.isError ? (
        <p className="mt-8 font-semibold">Couldn't load the report. {report.error.message}</p>
      ) : (
        <>
          <h2 className="mt-8 text-[19px] font-semibold leading-[1.35]">Monitors</h2>
          <p className="mt-1 max-w-[72ch] text-[14px] text-slate">
            Give a monitor an SLA target to see its error budget: the down time the month still
            allows.
          </p>
          {report.data.monitors.length === 0 ? (
            <EmptyState
              action={
                <Link href="/dashboard/monitors/" className={buttonClass()}>
                  Open Monitors
                </Link>
              }
            >
              No monitors yet. Add one and its months show here.
            </EmptyState>
          ) : (
            <DataTable
              label={`Monitors, ${label}`}
              data={report.data.monitors}
              columns={MONITOR_COLUMNS}
            />
          )}
          <h2 className="mt-8 text-[19px] font-semibold leading-[1.35]">Components</h2>
          {report.data.components.length === 0 ? (
            <EmptyState
              action={
                <Link href="/dashboard/status-page/components/" className={buttonClass()}>
                  Open Components
                </Link>
              }
            >
              No components yet. Add them to the status page and their months show here.
            </EmptyState>
          ) : (
            <DataTable
              label={`Components, ${label}`}
              data={report.data.components}
              columns={COMPONENT_COLUMNS}
            />
          )}
        </>
      )}
    </>
  );
}
