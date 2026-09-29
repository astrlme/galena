import type { ComponentStatus, PageIndicator } from "@galena/contracts";

// The state vocabulary for standalone files: labels, and the glyphs drawn on a 14×14 grid with
// the same shapes the dashboard and the page use, so every surface reads alike.

export type GlyphState = ComponentStatus | "no_data";

export const STATE_LABELS: Record<GlyphState, string> = {
  operational: "Operational",
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Maintenance",
  no_data: "No data",
};

export const INDICATOR_LABELS: Record<PageIndicator, string> = {
  none: "All systems operational",
  minor: "Some systems degraded",
  major: "Partial outage",
  critical: "Major outage",
};

/** The component state an indicator is drawn with. */
export const INDICATOR_STATE: Record<PageIndicator, ComponentStatus> = {
  none: "operational",
  minor: "degraded_performance",
  major: "partial_outage",
  critical: "major_outage",
};

/** SVG elements for a glyph in `color`, on a 14×14 grid. */
export function glyph(state: GlyphState, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="1.5"`;
  switch (state) {
    case "operational":
      return `<path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" ${stroke}/>`;
    case "degraded_performance":
      return `<path d="M1.5 7 C3 3.5 5 3.5 7 7 S11 10.5 12.5 7" ${stroke}/>`;
    case "partial_outage":
      return `<path d="M7 2 L12.5 12 L1.5 12 Z" fill="${color}"/>`;
    case "major_outage":
      return `<path d="M3 3 L11 11 M11 3 L3 11" fill="none" stroke="${color}" stroke-width="2"/>`;
    case "under_maintenance":
      return `<circle cx="7" cy="7" r="5" ${stroke} stroke-dasharray="2 2"/>`;
    case "no_data":
      return `<circle cx="7" cy="7" r="5" ${stroke}/>`;
  }
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Text for XML and SVG: markup characters escaped, control characters dropped. */
export function xml(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 forbids them
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c)
  );
}
