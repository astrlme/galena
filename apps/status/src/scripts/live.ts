import type { Snapshot } from "@galena/contracts";
import {
  componentStatusLabels,
  pageIndicatorLabels,
  pageIndicatorStates,
} from "@galena/contracts/copy";
import { type GlyphName, glyphs } from "@galena/ui/tokens";

// Keeps an open page current: polls snapshot.json every 30 s and swaps what changed in place,
// with no transition, announcing it through a polite live region. The HTML catches up with the
// next build; readers without JavaScript get that.

const POLL_MS = 30_000;
const STALE_MS = 2 * 60 * 60_000;
const two = (n: number) => String(n).padStart(2, "0");
const utcTime = (iso: string) => {
  const at = new Date(iso);
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
};

const root = document.documentElement;
const announce = document.querySelector<HTMLElement>("[data-live-announce]");
let version = Number(root.dataset.snapshotVersion);
let publishedAt = root.dataset.publishedAt ?? "";

function setGlyph(svg: Element | null, name: GlyphName) {
  if (svg) svg.innerHTML = glyphs[name]; // our own constant markup, never data
}

/** "Updated 14:02 UTC", or the warning once the page hasn't been confirmed for 2 hours. */
function freshness() {
  const line = document.querySelector("[data-live-updated]");
  if (!line || !publishedAt) return;
  const stale = Date.now() - Date.parse(publishedAt) > STALE_MS;
  line.textContent = `${stale ? "Status not confirmed since" : "Updated"} ${utcTime(publishedAt)}`;
}

function apply(s: Snapshot) {
  const headline = document.querySelector("[data-live-headline]");
  if (headline) headline.textContent = pageIndicatorLabels[s.indicator];
  setGlyph(document.querySelector("[data-live-hero-glyph]"), pageIndicatorStates[s.indicator]);
  for (const c of s.components) {
    const row = document.querySelector(`[data-component="${c.id}"]`);
    if (!row) continue;
    const label = row.querySelector("[data-live-status]");
    if (label) label.textContent = componentStatusLabels[c.status];
    setGlyph(row.querySelector("[data-live-glyph]"), c.status);
  }
  const notice = document.querySelector<HTMLElement>("[data-live-incidents]");
  const shown = new Set((notice?.dataset.ids ?? "").split(",").filter(Boolean));
  const active = s.incidents.active.map((i) => i.id);
  if (notice && (active.length !== shown.size || active.some((id) => !shown.has(id)))) {
    notice.hidden = false;
    notice.textContent = `Incidents changed since this page loaded. Reload to read them.`;
  }
  if (announce)
    announce.textContent = `${pageIndicatorLabels[s.indicator]}. Updated ${utcTime(s.publishedAt)}.`;
}

async function poll() {
  try {
    const response = await fetch("/snapshot.json", { cache: "no-cache" });
    if (response.ok) {
      const s = (await response.json()) as Snapshot;
      if (s.snapshotVersion > version) {
        version = s.snapshotVersion;
        publishedAt = s.publishedAt;
        apply(s);
      }
    }
  } catch {
    // Offline or the file is briefly missing: keep what is on screen, and say how old it is.
  }
  freshness();
}

freshness();
setInterval(poll, POLL_MS);
