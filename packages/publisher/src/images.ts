import { type PageIndicator, pageIndicatorLabels, pageIndicatorStates } from "@galena/contracts";
import { dark, light, stateTokens } from "@galena/ui/tokens";
import { type GlyphState, glyph, stateLabel, xml } from "./glyphs.ts";

// Standalone SVGs read without our CSS, so their colours are the token hex values.

const FONT = 'font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"';
/** Verdana's average advance at 11 px; the badge sizes itself from it. */
const CHAR = 6.6;

/** A state's colour in light or dark mode; no data is grey, at a strength text can sit on. */
const stateColour = (state: GlyphState, mode: typeof light | typeof dark) =>
  state === "no_data" ? mode.slate : mode[stateTokens[state]];

/**
 * `badge.svg`: "status" in white on ink, then the page's glyph and label in white on the state's
 * colour. Badges sit on READMEs of either theme, so they use the light values, which carry white
 * text at 4.5:1.
 */
export function badgeSvg(indicator: PageIndicator): string {
  const label = pageIndicatorLabels[indicator];
  const left = 46;
  const right = Math.ceil(28 + label.length * CHAR);
  const width = left + right;
  const state = stateColour(pageIndicatorStates[indicator], light);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="status: ${xml(label)}">`,
    `<title>status: ${xml(label)}</title>`,
    `<rect width="${left}" height="20" fill="${light.ink}"/>`,
    `<rect x="${left}" width="${right}" height="20" fill="${state}"/>`,
    `<text x="8" y="14" fill="${light.paper}" ${FONT}>status</text>`,
    `<g transform="translate(${left + 7} 3)">${glyph(pageIndicatorStates[indicator], light.paper)}</g>`,
    `<text x="${left + 25}" y="14" fill="${light.paper}" ${FONT}>${xml(label)}</text>`,
    "</svg>",
    "",
  ].join("\n");
}

/** A favicon per state: the glyph in its state's colour, following the reader's colour scheme. */
export function faviconSvg(state: GlyphState): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="32" height="32">`,
    `<title>${stateLabel(state)}</title>`,
    `<style>@media (prefers-color-scheme: dark) { g { color: ${stateColour(state, dark)} } }</style>`,
    glyph(state, stateColour(state, light)),
    "</svg>",
    "",
  ].join("\n");
}
