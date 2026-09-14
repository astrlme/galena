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
