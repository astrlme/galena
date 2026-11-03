import type { ComponentStatus } from "@galena/contracts";

// Every state is a label plus its glyph, never colour alone.
const LABELS: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Maintenance",
};

export function Glyph({ status }: { status: ComponentStatus | null }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
  } as const;
  switch (status) {
    case "operational": // ✓
      return (
        <svg aria-hidden="true" {...common}>
          <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" />
        </svg>
      );
    case "degraded_performance": // ∿
      return (
        <svg aria-hidden="true" {...common}>
          <path d="M1.5 7 C3 3.5 5 3.5 7 7 S11 10.5 12.5 7" />
        </svg>
      );
    case "partial_outage": // ▲
      return (
        <svg aria-hidden="true" {...common} fill="currentColor" stroke="none">
          <path d="M7 2 L12.5 12 L1.5 12 Z" />
        </svg>
      );
    case "major_outage": // ✕
      return (
        <svg aria-hidden="true" {...common} strokeWidth={2}>
          <path d="M3 3 L11 11 M11 3 L3 11" />
        </svg>
      );
    case "under_maintenance": // ◌
      return (
        <svg aria-hidden="true" {...common} strokeDasharray="2 2">
          <circle cx="7" cy="7" r="5" />
        </svg>
      );
    case null: // ○
      return (
        <svg aria-hidden="true" {...common}>
          <circle cx="7" cy="7" r="5" />
        </svg>
      );
  }
}

/** Each state's colour; the label and glyph still say it. */
const GLYPH_TONE: Record<ComponentStatus, string> = {
  operational: "text-operational",
  degraded_performance: "text-degraded",
  partial_outage: "text-partial",
  major_outage: "text-major",
  under_maintenance: "text-maintenance",
};

/** A badge's look: heavier for outages, and a major outage is the one filled badge. */
const TONE: Record<ComponentStatus, string> = {
  ...GLYPH_TONE,
  partial_outage: "font-semibold text-partial",
  major_outage: "border-major bg-major font-semibold text-paper",
};

/** What a monitor or alert route can mark its components while down, in order of severity. */
export const DOWN_STATUS_OPTIONS = [
  { value: "partial_outage" as const, label: "Partial outage", status: "partial_outage" as const },
  { value: "major_outage" as const, label: "Major outage", status: "major_outage" as const },
];

/**
 * A state badge: glyph and label in the state's colour on a hairline; a major outage is the one
 * filled badge. `null` is "No data": nothing has reported yet.
 */
export function StatusLabel({ status }: { status: ComponentStatus | null }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[6px] border border-mist px-2 py-0.5 text-[14px] ${status === null ? "text-slate" : TONE[status]}`}
    >
      <Glyph status={status} />
      {status === null ? "No data" : LABELS[status]}
    </span>
  );
}

/** A state's glyph in its colour, for beside its label (in a select, say). */
export function StateGlyph({ status }: { status: ComponentStatus }) {
  return (
    <span className={`inline-flex shrink-0 ${GLYPH_TONE[status]}`}>
      <Glyph status={status} />
    </span>
  );
}

/** A state's label: "Partial outage", or "No data" for null. */
export const labelOf = (status: ComponentStatus | null) =>
  status === null ? "No data" : LABELS[status];

/**
 * A glyph without its visible label, allowed only in a dashboard column, rail or tile whose
 * heading names what it shows: the label is in the tooltip and read out.
 */
export function GlyphOnly({
  status,
  label = labelOf(status),
}: {
  status: ComponentStatus | null;
  label?: string;
}) {
  return (
    <span title={label} className={`inline-flex ${status ? GLYPH_TONE[status] : "text-slate"}`}>
      <Glyph status={status} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
