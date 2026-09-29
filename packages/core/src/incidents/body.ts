import { err, ok, type Result } from "../result.ts";

// Updates are Markdown shown on the public page. This refuses what the page must never render;
// the page's renderer sanitises again.

const HTML_TAG = /<\/?[a-z][^>]*>/i;
/** Inline `[text](scheme:…)` and reference `[id]: scheme:…` link targets. */
const LINK_TARGETS =
  /\]\(\s*<?\s*([a-z][a-z\d+.-]*):|^\s*\[[^\]]+\]:\s*<?\s*([a-z][a-z\d+.-]*):/gim;
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const PLACEHOLDER = /\{[a-z]+\}/i;

export function checkUpdateBody(
  body: string,
): Result<string, "html_not_allowed" | "unsafe_link" | "unfilled_placeholder"> {
  if (HTML_TAG.test(body)) {
    return err(
      "html_not_allowed",
      "Remove the HTML tags. Updates are written in Markdown, which the page formats for you.",
    );
  }
  for (const [, inline, reference] of body.matchAll(LINK_TARGETS)) {
    const scheme = (inline ?? reference ?? "").toLowerCase();
    if (!SAFE_SCHEMES.has(scheme)) {
      return err("unsafe_link", "Links must start with https://, http:// or mailto:.");
    }
  }
  const placeholder = PLACEHOLDER.exec(body);
  if (placeholder) {
    return err(
      "unfilled_placeholder",
      `Replace ${placeholder[0]} with the details before posting.`,
    );
  }
  return ok(body);
}
