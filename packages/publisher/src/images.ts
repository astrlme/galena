import { type PageIndicator, pageIndicatorLabels, pageIndicatorStates } from "@galena/contracts";
import { dark, light } from "@galena/ui/tokens";
import { type GlyphState, glyph, stateLabel, xml } from "./glyphs.ts";

// Standalone SVGs read without our CSS, so their colours are the token hex values.

const FONT = 'font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"';
/** Verdana's average advance at 11 px; the badge sizes itself from it. */
const CHAR = 6.6;

/**
 * `badge.svg`: "status" in paper on ink, then the page's glyph and label in ink on surface.
 * A major outage inverts the right half, as the dashboard's major-outage badge does.
 */
export function badgeSvg(indicator: PageIndicator): string {
  const label = pageIndicatorLabels[indicator];
  const left = 46;
  const right = Math.ceil(28 + label.length * CHAR);
  const width = left + right;
  const major = indicator === "critical";
  const back = major ? light.ink : light.surface;
  const fore = major ? light.surface : light.ink;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="status: ${xml(label)}">`,
    `<title>status: ${xml(label)}</title>`,
    `<rect width="${left}" height="20" fill="${light.ink}"/>`,
    `<rect x="${left}" width="${right}" height="20" fill="${back}" stroke="${light.ink}"/>`,
    `<text x="8" y="14" fill="${light.paper}" ${FONT}>status</text>`,
    `<g transform="translate(${left + 7} 3)">${glyph(pageIndicatorStates[indicator], fore)}</g>`,
    `<text x="${left + 25}" y="14" fill="${fore}" ${FONT}>${xml(label)}</text>`,
    "</svg>",
    "",
  ].join("\n");
}

/** A favicon per state: the glyph in ink on transparent, following the reader's colour scheme. */
export function faviconSvg(state: GlyphState): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="32" height="32">`,
    `<title>${stateLabel(state)}</title>`,
    `<style>@media (prefers-color-scheme: dark) { g { color: ${dark.ink} } }</style>`,
    glyph(state, light.ink),
    "</svg>",
    "",
  ].join("\n");
}
