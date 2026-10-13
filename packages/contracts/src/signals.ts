import { z } from "zod";
import {
  downStatuses,
  publishPolicies,
  signalOutcomes,
  signalSources,
  signalStatuses,
} from "./enums.ts";
import { componentId, integrationId } from "./ids.ts";

/** Most alerts one signal carries; readers keep the first ones of a bigger group. */
export const MAX_SIGNAL_ALERTS = 100;
/** Most labels kept per alert, and their longest name and value. */
export const MAX_LABELS = 64;
export const MAX_LABEL_NAME = 100;
export const MAX_LABEL_VALUE = 1_000;

/** An alert's labels. Internal: they route the alert and never reach customer-facing text. */
export const labels = z
  .record(z.string().min(1).max(MAX_LABEL_NAME), z.string().max(MAX_LABEL_VALUE))
  .refine((l) => Object.keys(l).length <= MAX_LABELS, {
    message: `Use at most ${MAX_LABELS} labels.`,
  });
export type Labels = z.infer<typeof labels>;

/**
 * One alert group as a source reported it: Alertmanager's notification for a group, or one
 * generic JSON alert. Every notification about the group carries the same fingerprint.
 */
export const signal = z.object({
  source: z.enum(signalSources),
  fingerprint: z.string().regex(/^[\w-]{1,64}$/),
  status: z.enum(signalStatuses),
  /** When the group's earliest alert started: a group that fires again starts later. */
  startsAt: z.iso.datetime(),
  /** A short internal name, such as the alert name. */
  title: z.string().max(200),
  /** Each alert's labels, for routing. */
  alerts: z.array(labels).min(1).max(MAX_SIGNAL_ALERTS),
});
export type Signal = z.infer<typeof signal>;

/** Labels as a source sends them; the reader trims them to `labels`' limits. */
const sentLabels = z.record(z.string(), z.string());
/** RFC 3339 with any offset and precision (Alertmanager sends nanoseconds). */
const sentTime = z.iso.datetime({ offset: true });

/** Alertmanager's webhook body, version 4. Fields Galena doesn't read are dropped. */
export const alertmanagerPayload = z.object({
  version: z.literal("4"),
  groupKey: z.string().min(1),
  status: z.enum(signalStatuses),
  commonLabels: sentLabels.default({}),
  alerts: z
    .array(z.object({ status: z.enum(signalStatuses), labels: sentLabels, startsAt: sentTime }))
    .min(1),
});
export type AlertmanagerPayload = z.infer<typeof alertmanagerPayload>;

/** One alert in Galena's own JSON format: every notification about it repeats its `key`. */
export const genericAlert = z.object({
  key: z.string().min(1).max(200),
  status: z.enum(signalStatuses),
  startsAt: sentTime,
  title: z.string().max(200).optional(),
  labels: sentLabels.default({}),
});
export type GenericAlert = z.infer<typeof genericAlert>;

/** One alert, or a list of them. */
export const genericPayload = z.union([
  genericAlert.transform((alert) => [alert]),
  z.array(genericAlert).min(1).max(MAX_SIGNAL_ALERTS),
]);

const components = z
  .array(componentId)
  .min(1, "Pick at least one component.")
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: "List each component once." });

/** Alerts whose labels equal every label in `match` mark these components down. */
export const route = z.object({
  match: labels,
  componentIds: components,
  downStatus: z.enum(downStatuses).default("major_outage"),
});
export type Route = z.infer<typeof route>;

export const integrationInput = z.object({
  source: z.enum(signalSources),
  name: z.string().trim().min(1, "Give it a name, like the Alertmanager it listens to.").max(100),
  publishPolicy: z.enum(publishPolicies).default("approve"),
  /** In order: an alert takes the first route it matches. */
  routes: z.array(route).max(50).default([]),
});
export type IntegrationInput = z.infer<typeof integrationInput>;

/** The source stays: the hook URL names it. */
export const integrationUpdate = integrationInput.omit({ source: true });
export type IntegrationUpdate = z.infer<typeof integrationUpdate>;

/** Never the hook URL: it holds the token, and appears only when it is made. */
export const integrationView = z.object({
  id: integrationId,
  source: z.enum(signalSources),
  name: z.string(),
  publishPolicy: z.enum(publishPolicies),
  routes: z.array(route),
  lastSignalAt: z.iso.datetime().nullable(),
  lastOutcome: z.enum(signalOutcomes).nullable(),
  createdAt: z.iso.datetime(),
});
export type IntegrationView = z.infer<typeof integrationView>;

/** The hook URL, shown once: on create and when a new one replaces it. */
export const hookUrl = z.object({ url: z.url() });
export const integrationCreated = z.object({ integration: integrationView, url: z.url() });

/** What the API hands `signal.ingest`: one alert group, from the hook URL issued at `tokenIssuedAt`. */
export const signalIngest = z.object({
  integrationId,
  /** A run from a URL older than the integration's current one is dropped. */
  tokenIssuedAt: z.iso.datetime(),
  signal,
});
export type SignalIngest = z.infer<typeof signalIngest>;

/**
 * `sig:{integrationId}:{fingerprint}:{status}:{startsAt}`: a source repeating a notification
 * starts no run, and a group that fires again after resolving starts a new one.
 */
export const signalIdempotencyKey = ({ integrationId: id, signal: s }: SignalIngest) =>
  `sig:${id}:${s.fingerprint}:${s.status}:${s.startsAt}`;
