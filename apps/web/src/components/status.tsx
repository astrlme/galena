import type { ComponentStatus } from "@galena/contracts";

// Every state is a label plus its glyph, never colour alone.
const LABELS: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Maintenance",
};

function Glyph({ status }: { status: ComponentStatus }) {
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
  }
}

/** A state badge: glyph and label in a slate border; a major outage is the one inverted badge. */
export function StatusLabel({ status }: { status: ComponentStatus }) {
  const major = status === "major_outage";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-[14px] ${major ? "border-ink bg-ink font-semibold text-paper" : "border-slate"}`}
    >
      <Glyph status={status} />
      {LABELS[status]}
    </span>
  );
}
