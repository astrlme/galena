"use client";

import { useEffect, useRef } from "react";
import type uPlot from "uplot";
import { startOf } from "../../../../lib/time.ts";
import { useTokens } from "../../../../lib/use-tokens.ts";
import { latency } from "../monitor-row.ts";
import { AXIS, type Hover, type Point } from "./chart-data.ts";

const HEIGHT = 160;

/** A diagonal hatch for incident spans, drawn behind the lines. */
function hatch(ctx: CanvasRenderingContext2D, color: string, ratio: number) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 8 * ratio;
  const t = tile.getContext("2d");
  if (!t) return color;
  t.strokeStyle = color;
  t.lineWidth = ratio;
  t.beginPath();
  t.moveTo(0, 8 * ratio);
  t.lineTo(8 * ratio, 0);
  t.stroke();
  return ctx.createPattern(tile, "repeat") ?? color;
}

/**
 * One region's median (solid) and p95 (dashed 4-3) as 1.5 px `ink` lines on the shared scale,
 * incidents hatched in `ash` behind them, each line named at its end. The x axis runs to the end
 * of the last span, so an incident in it shows. Hovering moves every region's cursor to the same
 * span and reports it through `onHover` (undefined when the pointer leaves).
 */
export function RegionChart({
  keys,
  unit,
  points,
  yMax,
  incidents,
  label,
  describedBy,
  tick,
  step,
  onHover,
}: {
  keys: readonly string[];
  /** A span's length in ms: an hour or a day. */
  unit: number;
  /** One per key, or undefined where the span has no rollup. */
  points: readonly (Point | undefined)[];
  yMax: number;
  incidents: readonly { from: number; to: number }[];
  label: string;
  describedBy: string;
  /** An x tick's label from its time in epoch ms: "14:00", or "2 Nov". */
  tick: (ms: number) => string;
  /** Seconds between x ticks: 3 hours for a day, a day for a week, and so on. */
  step: number;
  onHover: (hover: Hover | undefined) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const tokens = useTokens();
  const hover = useRef(onHover);
  hover.current = onHover;

  useEffect(() => {
    const node = box.current;
    if (!node || !tokens) return;
    let chart: uPlot | undefined;
    let gone = false;
    const font = getComputedStyle(document.body).fontFamily;
    const ratio = window.devicePixelRatio || 1;
    const xs = keys.map((k) => startOf(k) / 1000);
    const data: uPlot.AlignedData = [
      xs,
      points.map((p) => p?.medianMs ?? null),
      points.map((p) => p?.p95Ms ?? null),
    ];
    const axis = {
      stroke: tokens.slate,
      font: `13px ${font}`,
      grid: { stroke: tokens.mist, width: 1 },
      ticks: { stroke: tokens.mist, width: 1 },
    };
    void import("uplot").then(({ default: UPlot }) => {
      if (gone) return;
      chart = new UPlot(
        {
          width: node.clientWidth,
          height: HEIGHT,
          padding: [8, 56, 0, 0],
          legend: { show: false },
          // Ticks on UTC hours and midnights, as every time on the page reads.
          tzDate: (ts) => UPlot.tzDate(new Date(ts * 1000), "Etc/UTC"),
          cursor: {
            sync: { key: "monitor" },
            drag: { x: false, y: false },
            y: false,
            points: { size: 6, fill: tokens.ink, stroke: tokens.ink },
          },
          scales: {
            x: { time: true, range: [xs[0] ?? 0, (xs.at(-1) ?? 0) + unit / 1000] },
            y: { range: [0, yMax] },
          },
          axes: [
            { ...axis, incrs: [step], values: (_u, ticks) => ticks.map((t) => tick(t * 1000)) },
            { ...axis, size: AXIS, values: (_u, ticks) => ticks.map((t) => latency(t)) },
          ],
          series: [
            {},
            { stroke: tokens.ink, width: 1.5, points: { show: false } },
            // uPlot scales line widths for the screen, not dashes.
            {
              stroke: tokens.ink,
              width: 1.5,
              dash: [4 * ratio, 3 * ratio],
              points: { show: false },
            },
          ],
          hooks: {
            drawClear: [
              (u) => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.fillStyle = hatch(ctx, tokens.ash, ratio);
                for (const i of incidents) {
                  const from = Math.max(bbox.left, u.valToPos(i.from / 1000, "x", true));
                  const to = Math.min(bbox.left + bbox.width, u.valToPos(i.to / 1000, "x", true));
                  // A short incident on a long range still shows: two pixels at least.
                  if (to >= from) {
                    ctx.fillRect(from, bbox.top, Math.max(to - from, 2 * ratio), bbox.height);
                  }
                }
                ctx.restore();
              },
            ],
            draw: [
              (u) => {
                // Each line's name at its last value, not in a legend: p95 is never below the
                // median, so its name goes above its line and the median's below.
                const { ctx } = u;
                ctx.save();
                ctx.fillStyle = tokens.slate;
                ctx.font = `${13 * ratio}px ${font}`;
                for (const [index, name, baseline, nudge] of [
                  [1, "Median", "top", 2],
                  [2, "p95", "bottom", -2],
                ] as const) {
                  ctx.textBaseline = baseline;
                  const values = u.data[index] ?? [];
                  let at = values.length - 1;
                  while (at >= 0 && values[at] == null) at--;
                  const value = values[at];
                  if (at < 0 || value == null) continue;
                  const x = u.valToPos(u.data[0][at] ?? 0, "x", true) + 4 * ratio;
                  ctx.fillText(name, x, u.valToPos(value, "y", true) + nudge * ratio);
                }
                ctx.restore();
              },
            ],
            setCursor: [
              (u) => {
                const { idx, left } = u.cursor;
                hover.current(
                  idx == null || left == null || left < 0
                    ? undefined
                    : { index: idx, left, width: u.over.clientWidth },
                );
              },
            ],
          },
        },
        data,
        node,
      );
    });
    const watch = new ResizeObserver(() =>
      chart?.setSize({ width: node.clientWidth, height: HEIGHT }),
    );
    watch.observe(node);
    return () => {
      gone = true;
      watch.disconnect();
      chart?.destroy();
    };
  }, [keys, unit, points, yMax, incidents, tokens, tick, step]);

  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      aria-describedby={describedBy}
      // uPlot draws its cursor line in its own colour; the tokens' `ash` replaces it.
      className="h-[160px] w-full [&_.u-hz_.u-cursor-x]:[border-right:1px_solid_var(--ash)]"
    />
  );
}
