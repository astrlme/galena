"use client";

import type { NoticeKind } from "@galena/contracts";
import { assertNever } from "@galena/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../components/button.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { Time } from "../incidents/incident-ui.tsx";
import { card, empty, row, small } from "./styles.ts";

type Endpoint =
  paths["/v1/webhook-endpoints"]["get"]["responses"][200]["content"]["application/json"][number];
type Delivery =
  paths["/v1/webhook-endpoints/{id}/deliveries"]["get"]["responses"][200]["content"]["application/json"][number];

const NOTICE: Record<NoticeKind, string> = {
  incident_created: "New incident",
  incident_updated: "Incident update",
  incident_resolved: "Incident resolved",
  maintenance_scheduled: "Maintenance scheduled",
  maintenance_started: "Maintenance started",
  maintenance_completed: "Maintenance completed",
  maintenance_cancelled: "Maintenance cancelled",
};
const tries = (n: number) => `${n} ${n === 1 ? "attempt" : "attempts"}`;

function outcome(d: Delivery) {
  switch (d.status) {
    case "sent":
      return d.attempts > 1 && d.sentAt ? (
        <>
          Sent on attempt {d.attempts}, <Time iso={d.sentAt} />.
        </>
      ) : (
        "Sent."
      );
    case "pending":
      return d.attempts === 0 ? "Waiting to be sent." : `Trying again later. ${d.lastError ?? ""}`;
    case "failed":
      return `Failed after ${tries(d.attempts)}. ${d.lastError ?? ""}`;
    case "skipped":
      return "Not sent: the destination was off.";
    default:
      return assertNever(d.status);
  }
}

/** What an endpoint was sent, newest first, with a way to send a settled delivery again. */
export function DeliveryLog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ id: string; detail: string; busy: boolean }>();
  const deliveries = useQuery({
    queryKey: ["webhook-endpoints", endpoint.id, "deliveries"],
    queryFn: () =>
      unwrap(
        api.GET("/v1/webhook-endpoints/{id}/deliveries", {
          params: { path: { id: endpoint.id } },
        }),
      ),
  });
  const resend = async (d: Delivery) => {
    setResult({ id: d.id, detail: "Sending it again…", busy: true });
    const params = { path: { id: endpoint.id, deliveryId: d.id } };
    const answer = await unwrap(
      api.POST("/v1/webhook-endpoints/{id}/deliveries/{deliveryId}/resend", { params }),
    ).catch((error: Error) => ({ detail: error.message }));
    setResult({ id: d.id, detail: answer.detail, busy: false });
    await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
  };
  const canResend = (d: Delivery) =>
    d.status !== "pending" && d.kind !== null && endpoint.state !== "disabled";

  return (
    <>
      <Modal.Title>Deliveries to {endpoint.name}</Modal.Title>
      <Modal.Description className="mt-2 text-slate">
        The last 50 notices, newest first.{" "}
        {endpoint.kind === "webhook"
          ? "One that fails is tried again 5 s, 30 s, 2 min, 10 min, 1 h, 6 h and 24 h later."
          : "One that fails is tried again within a few minutes."}
      </Modal.Description>
      {deliveries.isPending ? (
        <p className="mt-6 text-slate">Loading deliveries</p>
      ) : deliveries.error ? (
        <p className="mt-6 font-semibold">{deliveries.error.message}</p>
      ) : deliveries.data.length === 0 ? (
        <p className={empty}>
          Nothing sent yet. Incident and maintenance notices for this destination show here.
        </p>
      ) : (
        <ul className={card}>
          {deliveries.data.map((d) => (
            <li key={d.id} className={row}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">{d.title ?? "Sent before the delivery log"}</span>
                <span className="text-[14px]">
                  {d.kind ? NOTICE[d.kind] : "Notice"} at <Time iso={d.createdAt} />. {outcome(d)}
                </span>
                <span className="text-[14px]" aria-live="polite">
                  {result?.id === d.id ? result.detail : ""}
                </span>
              </div>
              {canResend(d) && (
                <div className="ml-auto">
                  <Button
                    className={small}
                    disabled={result?.id === d.id && result.busy}
                    onClick={() => void resend(d)}
                  >
                    {result?.id === d.id && result.busy ? "Sending…" : "Send again"}
                    <span className="sr-only">
                      {" "}
                      {d.title}, {d.kind && NOTICE[d.kind]}, <Time iso={d.createdAt} />
                    </span>
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <Button onClick={onClose}>Close</Button>
      </div>
    </>
  );
}
