"use client";

import { useEffect, useState } from "react";
import { two } from "../../lib/time.ts";

// Times that move: a countdown, "Updated 12 s ago". They swap their text in place once a second,
// with no transition, and are not live regions.

/** The time now, read again every `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "11 min 26 s" to `deadline`, "9 s" in its last minute, then "a moment". */
export function Countdown({ deadline, className = "" }: { deadline: string; className?: string }) {
  const now = useNow();
  const s = Math.round((Date.parse(deadline) - now) / 1000);
  const left =
    s <= 0 ? "a moment" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${two(s % 60)} s`;
  return <span className={`tabular-nums whitespace-nowrap ${className}`}>{left}</span>;
}
