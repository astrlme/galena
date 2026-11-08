"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/button.tsx";
import { StatusLabel } from "../../../../components/status.tsx";
import { toast } from "../../../../components/ui/toast.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import { two, utcClock } from "../../../../lib/time.ts";
import { useIsMobile } from "../../../../lib/use-is-mobile.ts";
import { IMPACT_TITLE, STATUS_LABELS } from "../incident-ui.tsx";
import type { IncidentDetail } from "./evidence.ts";
import { UpdateForm } from "./update-form.tsx";

// What a person does on the incident page: decide a draft, or post an update. A panel beside the
// evidence from 1024 px and above it from 640 px; below 640 px a sheet docked at the foot that
// keeps the decision in reach. The sheet isn't modal: the page behind it stays in use.

type Components = { id: string; name: string }[];

/** "11 min 26 s" to the deadline, swapped in place once a second (not a live region). */
function Countdown({ deadline, className = "" }: { deadline: string; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.round((Date.parse(deadline) - now) / 1000);
  const left =
    s <= 0 ? "a moment" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${two(s % 60)} s`;
  return <span className={`tabular-nums ${className}`}>{left}</span>;
}

function Deadline({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="tabular-nums">
      {utcClock(iso)}
    </time>
  );
}

/** Asks for the incident again once the deadline has passed: it is published by then. */
function useRefetchAfter(deadline: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!deadline) return;
    // The deadline job runs within a minute of its time.
    const wait = Date.parse(deadline) - Date.now() + 70_000;
    if (wait < 0) return;
    const timer = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: ["incidents"] }),
      wait,
    );
    return () => clearTimeout(timer);
  }, [deadline, queryClient]);
}

function useDecision(incident: IncidentDetail) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: "publish" | "dismiss") =>
      unwrap(
        api.POST("/v1/incidents/{id}/decision", {
          params: { path: { id: incident.id } },
          body: { decision },
        }),
      ),
    onSuccess: (_, decision) => {
      toast(decision === "publish" ? "Incident published" : "Draft dismissed");
      return queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
  });
}

type Decision = ReturnType<typeof useDecision>;

function DecisionButtons({ decision }: { decision: Decision }) {
  return (
    <>
      <Button
        variant="primary"
        disabled={decision.isPending}
        onClick={() => decision.mutate("publish")}
      >
        Approve and publish
      </Button>
      <Button disabled={decision.isPending} onClick={() => decision.mutate("dismiss")}>
        Dismiss
      </Button>
    </>
  );
}

function DecisionError({ decision }: { decision: Decision }) {
  return (
    <p role="alert" className="text-[14px] font-semibold empty:hidden">
      {decision.error?.message}
    </p>
  );
}

/** What the status page will show once the draft is published. */
function PagePreview({
  incident,
  nameOf,
}: {
  incident: IncidentDetail;
  nameOf: (id: string) => string;
}) {
  const latest = incident.updates[0];
  return (
    <div className="flex flex-col gap-2 rounded-[6px] border border-mist bg-paper p-3 text-[14px]">
      <span className={IMPACT_TITLE[incident.impact]}>{incident.title}</span>
      {incident.components.length > 0 && (
        <ul className="flex flex-col gap-1">
          {incident.components.map((c) => (
            <li key={c.componentId} className="flex flex-wrap items-center gap-2">
              {nameOf(c.componentId)} <StatusLabel status={c.status} />
            </li>
          ))}
        </ul>
      )}
      <span className="text-slate">{STATUS_LABELS[latest?.status ?? incident.status]}</span>
      <p className="max-w-[72ch] whitespace-pre-wrap">{latest?.body}</p>
    </div>
  );
}

const draftTitle = (incident: IncidentDetail) =>
  incident.source === "signal" ? "Draft from an alert" : "Draft from a monitor";

/** A draft's countdown, its page preview and the decision; posting an update waits behind a toggle. */
function DraftPanel({
  incident,
  components,
  nameOf,
  decision,
}: {
  incident: IncidentDetail;
  components: Components;
  nameOf: (id: string) => string;
  decision: Decision;
}) {
  const [isWriting, setIsWriting] = useState(false);
  const deadline = incident.approvalDeadline;
  return (
    <div className="flex flex-col gap-4">
      {deadline ? (
        <div className="flex flex-col gap-1 text-[14px] text-graphite">
          <span>Publishes automatically in</span>
          <Countdown
            deadline={deadline}
            className="text-[24px] leading-[1.25] font-semibold text-ink"
          />
          <span>
            at <Deadline iso={deadline} /> unless you approve or dismiss it sooner.
          </span>
        </div>
      ) : (
        <p className="text-[14px]">Not on the status page until you approve it.</p>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-[14px] text-graphite">What the status page will say</span>
        <PagePreview incident={incident} nameOf={nameOf} />
      </div>
      <div className="flex flex-wrap gap-3">
        <DecisionButtons decision={decision} />
      </div>
      <DecisionError decision={decision} />
      <div>
        <Button variant="quiet" aria-expanded={isWriting} onClick={() => setIsWriting(!isWriting)}>
          {isWriting ? "Hide the update form" : "Post an update to the draft"}
        </Button>
      </div>
      {isWriting && (
        <UpdateForm
          key={incident.updates.length}
          incident={incident}
          components={components}
          variant="secondary"
        />
      )}
    </div>
  );
}

/**
 * The panel beside (or above) the evidence, or below 640 px a sheet at the foot: collapsed, it
 * still holds the decision (or the way to the update form); expanded, everything the panel holds.
 */
export function IncidentPanel({
  incident,
  components,
  nameOf,
}: {
  incident: IncidentDetail;
  components: Components;
  nameOf: (id: string) => string;
}) {
  const decision = useDecision(incident);
  const [isOpen, setIsOpen] = useState(false);
  // One or the other, never both: a form mounted twice would hold two drafts and clashing ids.
  const isPhone = useIsMobile();
  // Focus follows the sheet: to its heading when it opens, back to the button when it closes.
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    (isOpen ? heading.current : opener.current)?.focus();
  }, [isOpen]);
  const toggle = (open: boolean) => {
    toggled.current = true;
    setIsOpen(open);
  };
  useRefetchAfter(incident.visibility === "draft" ? incident.approvalDeadline : null);
  const isDraft = incident.visibility === "draft";
  // A postmortem is the last word: nothing more to post.
  if (!isDraft && incident.status === "postmortem") return null;
  const title = isDraft ? draftTitle(incident) : "Post an update";
  const body: ReactNode = isDraft ? (
    <DraftPanel incident={incident} components={components} nameOf={nameOf} decision={decision} />
  ) : (
    <UpdateForm
      key={incident.updates.length}
      incident={incident}
      components={components}
      variant="primary"
    />
  );

  if (!isPhone) {
    return (
      <section
        aria-labelledby="panel-title"
        className="order-first flex flex-col gap-4 self-start rounded-xl border border-mist bg-surface p-4 lg:sticky lg:top-8 lg:order-none"
      >
        <h2 id="panel-title" className="text-[19px] leading-[1.35] font-semibold">
          {title}
        </h2>
        {body}
      </section>
    );
  }
  const deadline = isDraft ? incident.approvalDeadline : null;
  return (
    <section
      aria-label={title}
      className="fixed inset-x-0 bottom-0 z-50 rounded-t-[24px] border border-mist bg-surface px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {isOpen ? (
        // Padded so focus rings at the edges aren't clipped by the scrolling box.
        <div className="-mx-1 flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-1 py-1">
          <div className="flex items-center justify-between gap-3">
            <h2 ref={heading} tabIndex={-1} className="text-[19px] leading-[1.35] font-semibold">
              {title}
            </h2>
            <Button variant="quiet" aria-expanded onClick={() => toggle(false)}>
              Show less
            </Button>
          </div>
          {body}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {deadline && (
            <p className="text-[14px]">
              Publishes automatically at <Deadline iso={deadline} />, in{" "}
              <Countdown deadline={deadline} />, unless you approve or dismiss it sooner.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {isDraft ? (
              <>
                <DecisionButtons decision={decision} />
                <Button
                  ref={opener}
                  variant="quiet"
                  aria-expanded={false}
                  onClick={() => toggle(true)}
                >
                  Read the draft
                </Button>
              </>
            ) : (
              <Button
                ref={opener}
                variant="primary"
                aria-expanded={false}
                onClick={() => toggle(true)}
              >
                Post update
              </Button>
            )}
          </div>
          {isDraft && <DecisionError decision={decision} />}
        </div>
      )}
    </section>
  );
}
