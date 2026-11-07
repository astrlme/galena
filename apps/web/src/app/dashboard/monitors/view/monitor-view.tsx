"use client";

import { type SeriesRange, seriesRanges } from "@galena/contracts";
import { monitorStripDay } from "@galena/contracts/strip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../../components/button.tsx";
import { ConfirmDelete } from "../../../../components/confirm-delete.tsx";
import { Modal } from "../../../../components/modal.tsx";
import { runWith } from "../../../../components/run.ts";
import { StatusLabel } from "../../../../components/status.tsx";
import { Loading } from "../../../../components/ui/loading.tsx";
import { Tabs } from "../../../../components/ui/tabs.tsx";
import { toast } from "../../../../components/ui/toast.tsx";
import { UptimeBar } from "../../../../components/ui/uptime-bar.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import { CheckIns, NewPingUrl, RecentCheckIns } from "../heartbeat.tsx";
import { asBody, type FormOut, MonitorForm, policyLabel } from "../monitor-form.tsx";
import { latency, percent, watches } from "../monitor-row.ts";
import { useTelemetry } from "../telemetry.tsx";
import { Charts } from "./charts.tsx";
import { LastHour } from "./last-hour.tsx";

const RANGES: { value: SeriesRange; label: string; spoken: string }[] = [
  { value: "24h", label: "24 hours", spoken: "last 24 hours" },
  { value: "7d", label: "7 days", spoken: "last 7 days" },
  { value: "30d", label: "30 days", spoken: "last 30 days" },
  { value: "90d", label: "90 days", spoken: "last 90 days" },
];

/** One fact in the header: what it is, then its value. */
function Stat({ name, value, big = false }: { name: string; value: string; big?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[14px] text-slate">{name}</dt>
      <dd className={big ? "text-[19px] font-semibold tabular-nums" : "text-[14px]"}>{value}</dd>
    </div>
  );
}

export function MonitorView() {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.get("id") ?? "";
  const asked = params.get("range");
  const range: SeriesRange = seriesRanges.find((r) => r === asked) ?? "24h";
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string>();

  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => unwrap(api.GET("/v1/monitors")),
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  const telemetry = useTelemetry();
  const path = { params: { path: { id } } };
  // A heartbeat has no response times to chart.
  const charted = monitors.data?.monitors.find((m) => m.id === id)?.type === "http";
  const series = useQuery({
    queryKey: ["monitors", id, "series", range],
    queryFn: () =>
      unwrap(api.GET("/v1/monitors/{id}/series", { params: { path: { id }, query: { range } } })),
    enabled: id !== "" && charted,
  });
  const days = useQuery({
    queryKey: ["monitors", id, "days"],
    queryFn: () => unwrap(api.GET("/v1/monitors/{id}/days", path)),
    enabled: id !== "",
  });
  const checks = useQuery({
    queryKey: ["monitors", id, "checks"],
    queryFn: () => unwrap(api.GET("/v1/monitors/{id}/checks", path)),
    enabled: id !== "",
    refetchInterval: telemetry.paused ? false : 60_000,
  });
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setProblem(undefined);
      return queryClient.invalidateQueries({ queryKey: ["monitors"] });
    },
    onError: (error) => setProblem(error.message),
  });
  const run = runWith(change);

  if (monitors.isPending || components.isPending) return <Loading label="Loading monitor" />;
  if (monitors.isError) return <p className="mt-8 font-semibold">{monitors.error.message}</p>;
  const monitor = monitors.data.monitors.find((m) => m.id === id);
  if (!monitor) {
    return (
      <p className="mt-8">
        No monitor has this address.{" "}
        <Link href="/dashboard/monitors/" className="underline">
          Back to monitors
        </Link>
      </p>
    );
  }
  const reading = telemetry.data?.monitors.find((m) => m.id === id);
  const component = components.data?.components.find((c) => c.id === monitor.componentId);
  const spoken = RANGES.find((r) => r.value === range)?.spoken ?? "";
  const all = series.data?.totals.find((t) => t.region === null);
  const counted = series.data?.uptime;
  const quorum = monitor.detection.quorum;
  const heartbeat = monitor.heartbeat;
  const setRange = (next: SeriesRange) =>
    router.replace(`/dashboard/monitors/view/?id=${id}&range=${next}`, { scroll: false });
  const save = async (body: FormOut) => {
    const saved = await run(
      () => unwrap(api.PUT("/v1/monitors/{id}", { params: { path: { id } }, body: asBody(body) })),
      "Monitor saved",
    );
    if (saved) setEditing(false);
    return saved;
  };
  const remove = async () => {
    setDeleting(false);
    // Straight to the list: the shared mutation would refetch this page's own charts, which no
    // longer exist.
    try {
      await unwrap(api.DELETE("/v1/monitors/{id}", path));
    } catch (error) {
      setProblem((error as Error).message);
      return;
    }
    toast("Monitor deleted");
    router.push("/dashboard/monitors/");
    void queryClient.invalidateQueries({ queryKey: ["monitors"], exact: true });
  };

  return (
    <>
      <Link href="/dashboard/monitors/" className="text-[14px] text-slate hover:underline">
        Monitors
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[24px] font-semibold leading-[1.25] [overflow-wrap:anywhere]">
          {monitor.name}
        </h1>
        {monitor.enabled ? (
          <StatusLabel status={reading?.status ?? null} />
        ) : (
          <span className="text-slate">Paused</span>
        )}
      </div>
      <p className={`mt-1 text-[14px] text-slate ${heartbeat ? "" : "break-all"}`}>
        {watches(monitor)}
      </p>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
        <Stat name="Component" value={component ? component.name : "None"} />
        <Stat name="When it goes down" value={policyLabel(monitor.publishPolicy) ?? ""} />
      </dl>
      {heartbeat && <CheckIns schedule={heartbeat} lastPingAt={reading?.lastPingAt ?? null} />}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={() => setEditing(true)}>Edit monitor</Button>
        <Button
          onClick={() =>
            void run(
              () =>
                unwrap(
                  api.PATCH("/v1/monitors", { body: { ids: [id], enabled: !monitor.enabled } }),
                ),
              monitor.enabled ? "Monitor paused" : "Monitor resumed",
            )
          }
        >
          {monitor.enabled ? "Pause monitor" : "Resume monitor"}
        </Button>
        {heartbeat && <NewPingUrl id={id} name={monitor.name} />}
        <Button onClick={() => setDeleting(true)}>Delete monitor</Button>
      </div>
      <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
        {editing ? undefined : problem}
      </p>

      {!heartbeat && (
        <section aria-labelledby="response-times" className="mt-8">
          <h2 id="response-times" className="text-[19px] font-semibold leading-[1.35]">
            Response times
          </h2>
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            <Stat
              big
              name={`Median, ${spoken}`}
              value={all?.medianMs != null ? latency(all.medianMs) : "No data"}
            />
            <Stat
              big
              name={`p95, ${spoken}`}
              value={all?.p95Ms != null ? latency(all.p95Ms) : "No data"}
            />
            <Stat
              big
              name={`Uptime, ${spoken}`}
              value={
                counted && counted.minutes > 0
                  ? percent(1 - counted.minutesDown / counted.minutes)
                  : "No data"
              }
            />
          </dl>
          <div className="mt-4">
            <Tabs label="Range" value={range} tabs={RANGES} onChange={setRange}>
              {series.isPending ? (
                <Loading label="Loading response times" blocks={[160, 160, 160]} className="" />
              ) : series.isError ? (
                <p className="font-semibold">{series.error.message}</p>
              ) : (
                <Charts series={series.data} spoken={spoken} />
              )}
            </Tabs>
          </div>
        </section>
      )}

      {heartbeat && (
        <section aria-labelledby="check-ins" className="mt-8">
          <h2 id="check-ins" className="text-[19px] font-semibold leading-[1.35]">
            Recent check-ins
          </h2>
          <div className="mt-4 max-w-[72ch]">
            <RecentCheckIns id={id} paused={telemetry.paused} />
          </div>
        </section>
      )}

      <section aria-labelledby="uptime" className="mt-10">
        <h2 id="uptime" className="text-[19px] font-semibold leading-[1.35]">
          Uptime
        </h2>
        <p className="mt-1 max-w-[72ch] text-[14px] text-slate">
          {heartbeat
            ? "A minute is down while the job's check-in is late."
            : `A minute is down when at least ${quorum} ${quorum === 1 ? "region" : "regions"} failed it.`}{" "}
          Days run midnight to midnight UTC; today counts the hours so far.
        </p>
        <div className="mt-4">
          {days.data ? (
            <UptimeBar
              name={`${monitor.name} uptime`}
              days={days.data.days.map((d) => monitorStripDay(d, monitor.downStatus))}
              incidents={days.data.incidents.map((i) => ({ ...i, status: monitor.downStatus }))}
            />
          ) : (
            <Loading label="Loading uptime" blocks={[28]} className="" />
          )}
        </div>
      </section>

      <section aria-labelledby="last-hour" className="mt-10">
        <h2 id="last-hour" className="text-[19px] font-semibold leading-[1.35]">
          Last hour
        </h2>
        <div className="mt-4">
          {checks.data ? (
            <LastHour
              results={checks.data.results}
              quorum={quorum}
              downStatus={monitor.downStatus}
              regions={!heartbeat}
            />
          ) : (
            <Loading label="Loading recent checks" blocks={[28]} className="" />
          )}
        </div>
      </section>

      <Modal.Root open={editing} onClose={() => setEditing(false)}>
        <Modal.Title>{`Edit ${monitor.name}`}</Modal.Title>
        <MonitorForm
          title={`Edit ${monitor.name}`}
          editing={monitor}
          components={components.data?.components ?? []}
          problem={editing ? problem : undefined}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      </Modal.Root>
      {deleting && (
        <ConfirmDelete
          kind="monitor"
          name={monitor.name}
          consequence={
            heartbeat
              ? `Check-ins to ${monitor.name}'s ping URL stop counting within a minute. Its uptime history goes with it.`
              : `Probes stop checking ${monitor.name} within a minute. Its check history goes with it.`
          }
          onConfirm={() => void remove()}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}
