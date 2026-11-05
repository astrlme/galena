"use client";

import type { ComponentStatus, SnapshotDay } from "@galena/contracts";
import { componentStatusLabels } from "@galena/contracts/copy";
import {
  dayDetail,
  describeDay,
  STRIP_GAP,
  STRIP_MARK,
  STRIP_ROW,
  stripPaths,
  stripWidth,
} from "@galena/contracts/strip";
import { useEffect, useRef, useState } from "react";
import { hm, MONTHS, two } from "../../lib/time.ts";

// The status page's signal strip for the dashboard: one focusable element; arrow keys, Home and
// End move between days, each read out through a polite live region; hover or focus shows the
// day's minutes per state and its incidents. Only keyboard focus outlines the day. 90 days on
// desktop, 60 on tablets, 30 at 480 px and below, as on the status page.

const STEP = STRIP_MARK + STRIP_GAP;
const dayLabel = (date: string) => {
  const at = new Date(`${date}T00:00:00.000Z`);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
};
const hhmm = (iso: string) => {
  const at = new Date(iso);
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
};

// The shared strip names its marks; the tokens colour them.
const MARKS =
  "[&_.m-ok]:fill-operational [&_.m-degraded]:fill-degraded [&_.m-partial]:fill-partial [&_.m-major]:fill-major [&_.m-maintenance]:fill-maintenance [&_.m-none]:fill-ash";
const SWATCH: Record<ComponentStatus, string> = {
  operational: "bg-operational",
  degraded_performance: "bg-degraded",
  partial_outage: "bg-partial",
  major_outage: "bg-major",
  under_maintenance: "bg-maintenance",
};
const TIP = 240;

/** An incident the strip marks, in the state its monitor or component took. */
export type StripIncident = {
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  status: ComponentStatus;
};

/** How many days fit, and the room the popover has. Starts at 30, so nothing overflows first. */
function useFit() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const watch = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 480px)").matches;
  const fit = phone || width < stripWidth(60) ? 30 : width >= stripWidth(90) ? 90 : 60;
  return { box, fit, width };
}

export function UptimeBar({
  name,
  days: all,
  incidents,
}: {
  name: string;
  days: readonly SnapshotDay[];
  incidents: readonly StripIncident[];
}) {
  const { box, fit, width: room } = useFit();
  const days = all.slice(-fit);
  const last = days.length - 1;
  const [active, setActive] = useState<{ index: number; keyboard: boolean }>();
  const [said, setSaid] = useState("");
  // A new day count moves every index: start again rather than point at another date.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the fit changes
  useEffect(() => setActive(undefined), [fit]);
  const width = stripWidth(days.length);
  const marked = incidents.map((i) => ({
    ...i,
    components: [{ componentId: "", status: i.status }],
  }));

  const show = (index: number, keyboard: boolean) => {
    const i = Math.max(0, Math.min(last, index));
    setActive({ index: i, keyboard });
    const day = days[i];
    if (keyboard && day) setSaid(`${dayLabel(day.date)}: ${describeDay(day)}`);
  };
  const day = active ? days[active.index] : undefined;
  const detail = day ? dayDetail(day, marked, "", new Date().toISOString()) : undefined;
  const rows: Array<[ComponentStatus, number]> =
    detail?.m.length || !day?.worst ? (detail?.m ?? []) : [[day.worst, 1440]];
  const listed = all.filter((d) => d.worst !== "operational");

  return (
    <figure className="flex flex-col gap-1">
      <div ref={box} className="relative">
        {/* biome-ignore lint/a11y/useSemanticElements: the strip is one focusable control read day by day, as on the status page */}
        <div
          role="group"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move through its days
          tabIndex={0}
          aria-label={`${name}, the last ${days.length} days. Use the arrow keys to read each day.`}
          onFocus={(e) =>
            e.currentTarget.matches(":focus-visible") && show(active?.index ?? last, true)
          }
          onBlur={() => setActive(undefined)}
          onKeyDown={(e) => {
            const at = active?.index ?? last;
            const moves: Record<string, number> = {
              ArrowLeft: at - 1,
              ArrowRight: at + 1,
              Home: 0,
              End: last,
            };
            const next = moves[e.key];
            if (next === undefined) return;
            e.preventDefault();
            show(next, true);
          }}
          className="flex w-fit justify-end rounded-[2px] outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink"
        >
          <svg
            width={width}
            height={STRIP_ROW}
            viewBox={`0 0 ${width} ${STRIP_ROW}`}
            aria-hidden="true"
            className={MARKS}
            onPointerMove={(e) =>
              show(
                Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / STEP),
                false,
              )
            }
            onPointerLeave={() => {
              if (!active?.keyboard) setActive(undefined);
            }}
          >
            <rect x={0} y={STRIP_ROW - 1} width={width} height={1} className="fill-mist" />
            {stripPaths(days).map((p) => (
              <path key={p.className} className={p.className} d={p.d} />
            ))}
            {active?.keyboard && (
              <rect
                x={active.index * STEP - 1}
                y={0.5}
                width={STEP}
                height={STRIP_ROW - 1}
                fill="none"
                strokeWidth={1}
                className="stroke-ink"
              />
            )}
          </svg>
        </div>
        {day && active && (
          <div
            aria-hidden="true"
            style={{
              left: Math.max(0, Math.min(active.index * STEP - 40, room - TIP)),
              width: TIP,
            }}
            className="absolute top-[calc(100%+8px)] z-10 rounded-xl border border-mist bg-surface p-3 text-[14px]"
          >
            <p className="font-semibold">{dayLabel(day.date)}</p>
            {day.worst === null ? (
              <p className="mt-1 text-slate">No data</p>
            ) : rows.length === 0 ? (
              <p className="mt-1">{describeDay(day)}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {rows.map(([state, spent]) => (
                  <li key={state} className="flex items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-[2px] ${SWATCH[state]}`} />
                    <span>{componentStatusLabels[state]}</span>
                    <span className="ml-auto tabular-nums">{hm(spent)}</span>
                  </li>
                ))}
              </ul>
            )}
            {detail && detail.n.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 border-t border-mist pt-2">
                {detail.n.map(([title, start, end]) => (
                  <li key={`${title} ${start}`} className="flex flex-col">
                    <span>{title}</span>
                    <span className="text-slate tabular-nums">
                      {end ? `${hhmm(start)} to ${hhmm(end)} UTC` : `Since ${hhmm(start)} UTC`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {said}
        </p>
      </div>
      <figcaption aria-hidden="true" className="flex text-[13px] text-slate" style={{ width }}>
        <span>{days.length} days ago</span>
        <span className="ml-auto">Today</span>
      </figcaption>
      {/* A table keeps its content's width, so the hiding goes on a wrapper. */}
      <div className="sr-only">
        <table>
          <caption>
            {name}: days in the last {all.length} that were not fully operational, and days with no
            data. Every other day was operational.
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {listed.map((d) => (
              <tr key={d.date}>
                <td>{dayLabel(d.date)}</td>
                <td>{describeDay(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
