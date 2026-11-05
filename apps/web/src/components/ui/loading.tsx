"use client";

import { useEffect, useState } from "react";

const WAKING = "Waking the database. This takes about 15 seconds after a quiet period.";

/**
 * Still blocks where a list will be, never shimmering; the label is for assistive tech. After
 * 10 s the wait is explained in their place: a paused Aurora takes about 15 s to answer.
 */
export function Loading({
  label,
  rows = 3,
  className = "mt-8",
  table = false,
  framed = true,
  blocks,
}: {
  label: string;
  rows?: number;
  className?: string;
  /** A table's shape: a header and 36 px rows, so nothing jumps when the data arrives. */
  table?: boolean;
  /** Off inside a card that already draws the frame. */
  framed?: boolean;
  /** Still blocks of these heights in px instead of rows: a chart, a strip. */
  blocks?: number[];
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" className={className}>
      {slow ? (
        <p className="text-slate">{WAKING}</p>
      ) : (
        <>
          <span className="sr-only">{label}</span>
          {blocks ? (
            <div aria-hidden="true" className="flex flex-col gap-8">
              {blocks.map((height, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder blocks
                <div key={i} style={{ height }} className="rounded-xl bg-mist" />
              ))}
            </div>
          ) : (
            <div
              aria-hidden="true"
              className={framed ? "rounded-xl border border-mist bg-surface" : undefined}
            >
              {table && <div className="h-9 border-b border-mist" />}
              {Array.from({ length: rows }, (_, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows
                  key={i}
                  className={`flex ${table ? "h-9" : "h-14"} items-center gap-4 border-b border-mist px-4 last:border-b-0`}
                >
                  <span className="h-3 w-40 rounded-[6px] bg-mist" />
                  <span className="h-3 w-24 rounded-[6px] bg-mist" />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
