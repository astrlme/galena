import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A diagram from content/diagrams, inlined at build time so it follows the theme through the
 * tokens and uses the page's fonts. Each SVG carries its own title and description.
 */
export function Diagram({ name }: { name: string }) {
  const svg = readFileSync(join(process.cwd(), "content/diagrams", `${name}.svg`), "utf8");
  return (
    <figure
      className="diagram not-prose"
      aria-labelledby={`${name}-title`}
      // A wide diagram scrolls sideways on a phone, so the keyboard must be able to reach it.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs focus
      tabIndex={0}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG, read at build time
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
