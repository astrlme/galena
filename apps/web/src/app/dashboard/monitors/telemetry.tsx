"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";

type Telemetry =
  paths["/v1/monitors/telemetry"]["get"]["responses"][200]["content"]["application/json"];
export type Reading = Telemetry["monitors"][number];
export type Result = Reading["results"][number];

/** Enough minutes to find each region's latest result, though a region missed one or two. */
const MINUTES = 5;

/** After this long with nobody using the page, it stops polling. */
const AWAY_MS = 15 * 60_000;

/**
 * Whether someone has used the page in the last `ms`. Each poll asks the database, so a tab left
 * open would keep a paused Aurora awake all day.
 */
function usePresent(ms: number) {
  const [present, setPresent] = useState(true);
  useEffect(() => {
    let timer = setTimeout(() => setPresent(false), ms);
    const touch = () => {
      clearTimeout(timer);
      setPresent(true);
      timer = setTimeout(() => setPresent(false), ms);
    };
    const events = ["pointermove", "pointerdown", "keydown", "focus"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, [ms]);
  return present;
}

/**
 * Each monitor's state, newest results and summary. Checks run once a minute, so polling every
 * 30 s while someone is on the page is fresh enough. Away for 15 minutes, it stops (`paused`),
 * and starts again with a fresh read when they return.
 */
export function useTelemetry() {
  const present = usePresent(AWAY_MS);
  const query = useQuery({
    queryKey: ["monitors", "telemetry"],
    queryFn: () =>
      unwrap(api.GET("/v1/monitors/telemetry", { params: { query: { minutes: MINUTES } } })),
    refetchInterval: present ? 30_000 : false,
  });
  const wasPresent = useRef(present);
  const { refetch } = query;
  useEffect(() => {
    if (present && !wasPresent.current) void refetch();
    wasPresent.current = present;
  }, [present, refetch]);
  return { ...query, paused: !present };
}

/** Said where check results show, while polling is paused. */
export function PausedNotice({ paused }: { paused: boolean }) {
  return (
    <p className="text-[14px] text-slate empty:hidden" role="status">
      {paused ? "Updates paused while you're away. They start again when you come back." : ""}
    </p>
  );
}
