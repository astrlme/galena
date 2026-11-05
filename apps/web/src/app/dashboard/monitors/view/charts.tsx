"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { spans } from "../../../../lib/time.ts";
import { Time } from "../../incidents/incident-ui.tsx";
import { type Hover, niceMax, type Series, TICKS, tickLabel } from "./chart-data.ts";
import { RegionPanel } from "./region-panel.tsx";

const HOUR = 3_600_000;

/** One chart per region on a shared scale, then the incidents in the range as links. */
export function Charts({ series, spoken }: { series: Series; spoken: string }) {
  const [hover, setHover] = useState<Hover>();
  // Built once per response: a hover re-renders, and new arrays would rebuild every chart.
  const chart = useMemo(() => {
    const keys = spans(series.step, series.from, series.to);
    const regions = [...new Set(series.totals.flatMap((t) => (t.region ? [t.region] : [])))];
    const now = Date.now();
    return {
      keys,
      unit: series.step === "hour" ? HOUR : 24 * HOUR,
      yMax: niceMax(series.points),
      tick: tickLabel(series.range),
      incidents: series.incidents.map((i) => ({
        from: Date.parse(i.startedAt),
        to: i.resolvedAt ? Date.parse(i.resolvedAt) : now,
      })),
      regions: regions.map((region) => {
        const byKey = new Map(
          series.points.filter((p) => p.region === region).map((p) => [p.at, p]),
        );
        return { region, points: keys.map((k) => byKey.get(k)) };
      }),
    };
  }, [series]);

  if (chart.regions.length === 0) {
    return (
      <p className="text-[14px] text-slate">
        Nothing rolled up for this range yet. Checks are rolled up each hour, at five past.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {chart.regions.map(({ region, points }) => (
        <RegionPanel
          key={region}
          region={region}
          keys={chart.keys}
          unit={chart.unit}
          points={points}
          total={series.totals.find((t) => t.region === region)}
          spoken={spoken}
          yMax={chart.yMax}
          incidents={chart.incidents}
          tick={chart.tick}
          step={TICKS[series.range]}
          hover={hover}
          onHover={setHover}
        />
      ))}
      {series.incidents.length > 0 && (
        <section aria-labelledby="range-incidents">
          <h3 id="range-incidents" className="text-[16px] font-semibold">
            Incidents in this range
          </h3>
          <ul className="mt-2 flex flex-col gap-1 text-[14px]">
            {series.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap gap-x-2">
                <Link href={`/dashboard/incidents/view/?id=${i.id}`} className="underline">
                  {i.title}
                </Link>
                <span className="text-slate">
                  {i.resolvedAt ? (
                    <>
                      <Time iso={i.startedAt} /> to <Time iso={i.resolvedAt} />
                    </>
                  ) : (
                    <>
                      Since <Time iso={i.startedAt} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
