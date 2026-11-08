"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../components/button.tsx";
import { Modal } from "../../../components/modal.tsx";
import { Loading } from "../../../components/ui/loading.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { Time } from "../incidents/incident-ui.tsx";
import { Fact } from "./fact.tsx";

// A heartbeat monitor's own parts: its check-ins, and its ping URL, which is shown only once.

export type ShownUrl = { name: string; url: string };

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The newest check-in, when the next is due and when it counts as late. The sweeper looks once a
 * minute, so a late check-in shows within a minute after the grace ends.
 */
export function CheckIns({
  schedule,
  lastPingAt,
}: {
  schedule: { periodMinutes: number; graceMinutes: number };
  lastPingAt: string | null;
}) {
  if (!lastPingAt) {
    return (
      <p className="mt-3 max-w-[72ch] text-[14px]">
        Waiting for the first check-in. The monitor shows No data until the job calls its ping URL.
        If the URL is lost, make a new one.
      </p>
    );
  }
  const due = Date.parse(lastPingAt) + schedule.periodMinutes * MINUTE;
  // Read when the page renders; it refreshes with the telemetry.
  const overdue = due < Date.now();
  return (
    <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
      <Fact name="Last check-in">
        <Time iso={lastPingAt} />
      </Fact>
      <Fact name={overdue ? "Next one was due by" : "Next one due by"}>
        <Time iso={iso(due)} />
      </Fact>
      <Fact name="Late after">
        <Time iso={iso(due + schedule.graceMinutes * MINUTE)} />
      </Fact>
    </dl>
  );
}

/** A heartbeat's ping URL, shown once: after the monitor is added or a new URL is made. */
export function PingUrlDialog({
  shown,
  onDone,
}: {
  shown: ShownUrl | undefined;
  onDone: () => void;
}) {
  return (
    <Modal.Root
      kind="dialog"
      open={shown !== undefined}
      onClose={onDone}
      // A URL that isn't shown again closes only on Done.
      closeOnOverlayClick={false}
      closeOnEsc={false}
    >
      {shown && (
        <>
          <Modal.Title>Ping URL for {shown.name}</Modal.Title>
          <div role="status" className="mt-4 flex flex-col gap-2">
            <p className="sr-only">Ping URL for {shown.name}</p>
            <p className="break-all rounded-[6px] border border-mist bg-paper p-3 font-mono text-[14px]">
              {shown.url}
            </p>
            <p className="text-[14px] text-slate">
              Copy it now: it isn't shown again. Call it from the job each time it finishes, with
              GET or POST, for example{" "}
              <code className="font-mono">curl -fsS --retry 3 &lt;URL&gt;</code>.
            </p>
          </div>
          <div className="mt-6">
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
          </div>
        </>
      )}
    </Modal.Root>
  );
}

/** The heartbeat's recent check-ins, newest first, refreshed with the rest of the page. */
export function RecentCheckIns({ id, paused }: { id: string; paused: boolean }) {
  const list = useQuery({
    queryKey: ["monitors", id, "check-ins"],
    queryFn: () => unwrap(api.GET("/v1/monitors/{id}/check-ins", { params: { path: { id } } })),
    refetchInterval: paused ? false : 60_000,
  });
  if (list.isPending) return <Loading label="Loading check-ins" blocks={[28]} className="" />;
  if (list.isError) return <p className="font-semibold">{list.error.message}</p>;
  if (list.data.checkIns.length === 0) {
    return <p className="text-[14px] text-slate">No check-ins in the last 30 days.</p>;
  }
  return (
    <ol className="rounded-xl border border-mist bg-surface text-[14px]">
      {list.data.checkIns.map((at) => (
        <li key={at} className="border-b border-mist px-4 py-2 last:border-b-0">
          <Time iso={at} />
        </li>
      ))}
    </ol>
  );
}

/** "Make new ping URL": asks first, then shows the new URL once. */
export function NewPingUrl({ id, name }: { id: string; name: string }) {
  const [asking, setAsking] = useState(false);
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [shown, setShown] = useState<ShownUrl>();
  const make = async () => {
    setMaking(true);
    try {
      const { url } = await unwrap(
        api.POST("/v1/monitors/{id}/ping-url", { params: { path: { id } } }),
      );
      setAsking(false);
      setProblem(undefined);
      setShown({ name, url });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setMaking(false);
    }
  };
  return (
    <>
      <Button onClick={() => setAsking(true)}>Make new ping URL</Button>
      <Modal.Root
        kind="dialog"
        open={asking}
        onClose={() => {
          setAsking(false);
          setProblem(undefined);
        }}
      >
        <Modal.Title>Make a new ping URL for {name}?</Modal.Title>
        <Modal.Description>
          Check-ins through the current URL stop counting within about a minute. The monitor goes
          down when its next check-in is late, unless the job calls the new URL by then.
        </Modal.Description>
        <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
          {problem}
        </p>
        <div className="mt-6 flex gap-4">
          <Button variant="primary" disabled={making} onClick={() => void make()}>
            {making ? "Making new ping URL…" : "Make new ping URL"}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setAsking(false);
              setProblem(undefined);
            }}
          >
            Cancel
          </Button>
        </div>
      </Modal.Root>
      <PingUrlDialog shown={shown} onDone={() => setShown(undefined)} />
    </>
  );
}
