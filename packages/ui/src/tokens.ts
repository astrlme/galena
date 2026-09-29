// The tokens from tokens.css as hex strings, for places that cannot read CSS variables:
// emails, standalone SVGs (badge, favicons) and chat embeds. tokens.test.ts keeps both in step.

export const light = {
  paper: "#F7F8F9",
  surface: "#FFFFFF",
  mist: "#E4E7EB",
  ash: "#B8BDC5",
  slate: "#6A707C",
  graphite: "#3B404A",
  ink: "#15171C",
} as const;

export const dark = {
  paper: "#111317",
  surface: "#181B20",
  mist: "#272B32",
  ash: "#474D57",
  slate: "#8E949F",
  graphite: "#C4C9D1",
  ink: "#EEF0F3",
} as const;

// Discord embed and Slack attachment bars.
// Meaning is carried by the glyph and title, never by these colours.
export const embed = {
  operational: "#7D838E",
  degraded: "#6A707C",
  maintenance: "#626874",
  partial: "#545A66",
  major: "#3B404A",
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
