import { type ComponentStatus, EXPIRY_THRESHOLDS, expirySubjects } from "@galena/contracts";
import type { Answer } from "../../lib/answer.ts";
import { compareIso, utcClock } from "../../lib/time.ts";
import { ago } from "./monitors/monitor-row.ts";

// What Home says needs a person, and what happened lately, from the reads it already makes.

export type HomeData = {
  now: number;
  /** Open incidents: drafts, published and internal ones. */
  incidents: Answer<"/v1/incidents">["incidents"];
  /** The latest resolved or dismissed ones. */
  resolved: Answer<"/v1/incidents">["incidents"];
  monitors: Answer<"/v1/monitors">["monitors"];
  readings: Answer<"/v1/monitors/telemetry">["monitors"];
  /** Null for members who can't see destinations (below admin). */
  endpoints: Answer<"/v1/webhook-endpoints"> | null;
  expiries: Answer<"/v1/expiries">["expiries"];
};

export type NeedKind = "draft" | "down" | "destination" | "expiry" | "stale";

export type Need = {
  key: string;
  kind: NeedKind;
  /** "Draft from a monitor": what kind of thing it is, in words. */
  label: string;
  /** A down monitor's state, shown beside its label; null for the other kinds. */
  status: ComponentStatus | null;
  title: string;
  detail: string;
  /** A draft's deadline, for a countdown. */
  deadline?: string;
  action: { label: string; href: string };
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** An open incident without an update for this long is flagged: subscribers hear nothing new. */
export const STALE_MINUTES = 30;
/** Certificates and domains count as soon from the first warning on. */
const SOON_DAYS = EXPIRY_THRESHOLDS[0];
const WARNINGS = `${EXPIRY_THRESHOLDS.slice(0, -1).join(", ")} and ${EXPIRY_THRESHOLDS.at(-1)} days`;

export const incidentPage = (id: string) => `/dashboard/incidents/view/?id=${id}`;
export const monitorPage = (id: string) => `/dashboard/monitors/view/?id=${id}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const earliest =
  <T>(at: (item: T) => string | null) =>
  (a: T, b: T) =>
    compareIso(at(a), at(b));

type Reading = HomeData["readings"][number];
type Incident = HomeData["incidents"][number];

/** "Webhooks is down in 2 of 3 regions", from each region's newest result. */
function downTitle(name: string, reading: Reading, isHeartbeat: boolean) {
  if (isHeartbeat) return `${name} is down`;
  const latest = new Map<string, string>();
  for (const r of reading.results) if (!latest.has(r.region)) latest.set(r.region, r.status);
  const failing = [...latest.values()].filter((s) => s === "down").length;
  return `${name} is down in ${failing} of ${latest.size} regions`;
}

/**
 * Everything waiting for a person, most urgent first: drafts, down monitors, failing
 * destinations, expiring certificates and domains, stale incidents. A down monitor with an open
 * incident of its own is that incident's work: a draft holds it, and a published one shows it
 * once it goes stale.
 */
export function needsOf(data: HomeData): Need[] {
  const { now } = data;
  const readings = new Map(data.readings.map((r) => [r.id, r]));
  const isStale = (i: Incident) =>
    i.visibility !== "draft" && now - Date.parse(i.updatedAt) >= STALE_MINUTES * MINUTE;
  const ownIncident = new Map(
    data.incidents.flatMap((i) => (i.monitorId ? [[i.monitorId, i]] : [])),
  );
  const isDown = (monitorId: string) => readings.get(monitorId)?.state === "down";

  const drafts = data.incidents
    .filter((i) => i.visibility === "draft")
    .toSorted(earliest((i) => i.approvalDeadline))
    .map(
      (i): Need => ({
        key: `draft:${i.id}`,
        kind: "draft",
        label: i.source === "signal" ? "Draft from an alert" : "Draft from a monitor",
        status: null,
        title: i.title,
        detail: i.approvalDeadline
          ? `Publishes automatically at ${utcClock(i.approvalDeadline)} unless you approve or dismiss it sooner.`
          : "Not on the status page until you approve it.",
        ...(i.approvalDeadline ? { deadline: i.approvalDeadline } : {}),
        action: { label: "Review draft", href: incidentPage(i.id) },
      }),
    );

  // A down monitor's own draft holds it, and its own fresh incident is being handled; it joins
  // the list once that incident goes stale, in its own slot.
  const down = data.monitors
    .flatMap((m) => {
      const reading = readings.get(m.id);
      const own = ownIncident.get(m.id);
      return m.enabled && reading?.state === "down" && (!own || isStale(own))
        ? [{ m, reading, own }]
        : [];
    })
    .toSorted(earliest(({ reading }) => reading.since))
    .map(({ m, reading, own }): Need => {
      const since = reading.since ? `Since ${utcClock(reading.since)}. ` : "";
      const other = data.incidents.find(
        (i) => i.monitorId !== m.id && i.components.some((c) => c.componentId === m.componentId),
      );
      return {
        key: `down:${m.id}`,
        kind: "down",
        label: "Monitor down",
        status: reading.status,
        title: downTitle(m.name, reading, m.type === "heartbeat"),
        detail: own
          ? `${since}"${own.title}" was last updated ${ago(own.updatedAt, now).toLowerCase()}.`
          : other
            ? `${since}"${other.title}" is open on its component.`
            : `${since}No incident is open for it.`,
        action: own
          ? { label: "Post update", href: incidentPage(own.id) }
          : { label: "Open monitor", href: monitorPage(m.id) },
      };
    });

  const destinations = (data.endpoints ?? [])
    .filter((e) => e.state === "failing")
    .toSorted(earliest((e) => e.failingSince))
    .map(
      (e): Need => ({
        key: `destination:${e.id}`,
        kind: "destination",
        label: "Destination failing",
        status: null,
        title: `${e.name} isn't receiving notifications`,
        detail: `${e.failingSince ? `Failing since ${utcClock(e.failingSince)}. ` : ""}Its delivery log says why.`,
        action: { label: "Open destinations", href: "/dashboard/status-page/subscribers/" },
      }),
    );

  const expiries = data.expiries
    .flatMap((e) =>
      e.expiresAt !== null && Date.parse(e.expiresAt) - now <= SOON_DAYS * DAY
        ? [{ ...e, expiresAt: e.expiresAt }]
        : [],
    )
    .toSorted(earliest((e) => e.expiresAt))
    .map((e): Need => {
      const left = Math.ceil((Date.parse(e.expiresAt) - now) / DAY);
      const when = left <= 0 ? "expired" : `expires in ${plural(left, "day")}`;
      return {
        key: `expiry:${e.kind}:${e.name}`,
        kind: "expiry",
        label: e.kind === "certificate" ? "Certificate expiring" : "Domain expiring",
        status: null,
        title: `${expirySubjects[e.kind](e.name)} ${when}`,
        detail: `${e.issuer ? `Issued by ${e.issuer}. ` : ""}Members get a warning at ${WARNINGS}.`,
        action: {
          label: "Open monitor",
          href: e.monitorIds[0] ? monitorPage(e.monitorIds[0]) : "/dashboard/monitors/",
        },
      };
    });

  // An incident whose monitor is down is in that monitor's card already.
  const stale = data.incidents
    .filter((i) => isStale(i) && !(i.monitorId && isDown(i.monitorId)))
    .toSorted(earliest((i) => i.updatedAt))
    .map((i): Need => {
      const quiet =
        i.visibility === "published" ? " Subscribers hear nothing new until you post one." : "";
      return {
        key: `stale:${i.id}`,
        kind: "stale",
        label: "No recent update",
        status: null,
        title: i.title,
        detail: `Last update ${ago(i.updatedAt, now).toLowerCase()}.${quiet}`,
        action: { label: "Post update", href: incidentPage(i.id) },
      };
    });

  return [...drafts, ...down, ...destinations, ...expiries, ...stale];
}

export type Activity = { key: string; at: string; text: string };

const STATE_WORDS: Partial<Record<Reading["state"], string>> = {
  down: "went down",
  recovering: "is recovering",
  flapping: "is flapping",
  degraded: "is slow",
};

/** What happened lately, newest first: incidents, monitors that changed state, destinations. */
export function activityOf(data: HomeData, count = 6): Activity[] {
  const readings = new Map(data.readings.map((r) => [r.id, r]));
  const events: Activity[] = [
    ...[...data.incidents, ...data.resolved].flatMap((i) => [
      {
        key: `${i.id}:opened`,
        at: i.startedAt,
        text: `${i.title} opened${i.source === "monitor" ? " by a monitor" : ""}`,
      },
      ...(i.resolvedAt
        ? [{ key: `${i.id}:resolved`, at: i.resolvedAt, text: `${i.title} resolved` }]
        : i.updatedAt !== i.startedAt
          ? [{ key: `${i.id}:updated`, at: i.updatedAt, text: `${i.title} updated` }]
          : []),
    ]),
    ...data.monitors.flatMap((m) => {
      const reading = readings.get(m.id);
      const words = reading && m.enabled ? STATE_WORDS[reading.state] : undefined;
      return words && reading?.since
        ? [{ key: `${m.id}:state`, at: reading.since, text: `${m.name} ${words}` }]
        : [];
    }),
    ...(data.endpoints ?? []).flatMap((e) =>
      e.failingSince
        ? [{ key: `${e.id}:failing`, at: e.failingSince, text: `${e.name} started failing` }]
        : [],
    ),
  ];
  return events.toSorted((a, b) => compareIso(b.at, a.at)).slice(0, count);
}
