// The tokens from tokens.css as hex strings, for places that cannot read CSS variables:
// emails, standalone SVGs (badge, favicons) and chat embeds. tokens.test.ts keeps both in step.

export const light = {
  paper: "#FFFFFF",
  surface: "#FAFAFA",
  mist: "#E5E5E5",
  ash: "#A3A3A3",
  slate: "#6B6B6B",
  graphite: "#404040",
  ink: "#0A0A0A",
  operational: "#15803D",
  degraded: "#A16207",
  partial: "#C2410C",
  major: "#DC2626",
  maintenance: "#2563EB",
  /** Behind dialogs and drawers, at 60%: black in both modes. */
  scrim: "#000000",
} as const;

export const dark = {
  paper: "#000000",
  surface: "#111111",
  mist: "#262626",
  ash: "#525252",
  slate: "#A3A3A3",
  graphite: "#D4D4D4",
  ink: "#FAFAFA",
  operational: "#22C55E",
  degraded: "#EAB308",
  partial: "#F97316",
  major: "#EF4444",
  maintenance: "#3B82F6",
  scrim: "#000000",
} as const;

// Slack attachment bars and Discord embeds: the dark values, which sit mid-range and show on
// light and dark client themes alike. The glyph and title still carry the meaning.
export const embed = {
  operational: dark.operational,
  degraded: dark.degraded,
  partial: dark.partial,
  major: dark.major,
  maintenance: dark.maintenance,
} as const;

export type Token = keyof typeof light;

// The state glyphs on a 14×14 grid, drawn in currentColor. Every surface uses these shapes:
// the dashboard, the status page and standalone SVGs (which set `color` on their root).
const line = 'fill="none" stroke="currentColor" stroke-width="1.5"';
export const glyphs = {
  operational: `<path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" ${line}/>`,
  degraded_performance: `<path d="M1.5 7 C3 3.5 5 3.5 7 7 S11 10.5 12.5 7" ${line}/>`,
  partial_outage: `<path d="M7 2 L12.5 12 L1.5 12 Z" fill="currentColor"/>`,
  major_outage: `<path d="M3 3 L11 11 M11 3 L3 11" fill="none" stroke="currentColor" stroke-width="2"/>`,
  under_maintenance: `<circle cx="7" cy="7" r="5" ${line} stroke-dasharray="2 2"/>`,
  no_data: `<circle cx="7" cy="7" r="5" ${line}/>`,
} as const;
export type GlyphName = keyof typeof glyphs;

/** Each state's colour token; no data stays grey. Labels and glyphs still carry the meaning. */
export const stateTokens = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "partial",
  major_outage: "major",
  under_maintenance: "maintenance",
  no_data: "ash",
} as const satisfies Record<GlyphName, Token>;
