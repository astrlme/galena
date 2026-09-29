import type { ComponentStatus } from "@galena/contracts";
import { componentStatusLabels } from "@galena/contracts";
import { type GlyphName, glyphs } from "@galena/ui/tokens";

// The state vocabulary for standalone files, from the shared glyph shapes and labels.

export type GlyphState = ComponentStatus | "no_data";

export const stateLabel = (state: GlyphState) =>
  state === "no_data" ? "No data" : componentStatusLabels[state];

/** A glyph on a 14×14 grid in `color`. */
export const glyph = (state: GlyphState, color: string) =>
  `<g color="${color}">${glyphs[state satisfies GlyphName]}</g>`;

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
