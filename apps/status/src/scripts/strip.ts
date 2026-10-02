import type { ComponentStatus } from "@galena/contracts";
import { componentStatusLabels } from "@galena/contracts/copy";
import type { DayDetail } from "../lib/strip.ts";

// The signal strip for keyboards and pointers: one focusable element per strip; arrow keys (and
// Home, End) move between days, the day is read out through a polite live region, and hover or
// focus shows a popover with the day's minutes per state and its incidents. Only keyboard focus
// outlines the day, so a pointer gets the popover without a box following it. Nothing moves on
// its own.

const STEP = 6; // a 4 px mark and a 2 px gap
const DAY_MS = 86_400_000;
const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );
const two = (n: number) => String(n).padStart(2, "0");

const dayAt = (start: string, index: number) =>
  new Date(Date.parse(`${start}T00:00:00.000Z`) + index * DAY_MS);
const dayLabel = (at: Date) => `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;

/** "23h 8m", "52m", "24h". */
function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "09:44", or "30 September, 23:30" when it falls on another day than the popover's. */
function when(iso: string, day: Date): string {
  const at = new Date(iso);
  const time = `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
  return at.toISOString().slice(0, 10) === day.toISOString().slice(0, 10)
    ? time
    : `${dayLabel(at)}, ${time}`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function swatch(state: ComponentStatus): HTMLElement {
  const node = el("span", "tip-swatch");
  node.dataset.state = state;
  return node;
}

/** The popover's contents for one day, built from text nodes only. */
function fill(tip: HTMLElement, day: Date, detail: DayDetail | undefined, hasData: boolean) {
  tip.replaceChildren(el("p", "tip-date", `${dayLabel(day)} ${day.getUTCFullYear()}`));
  if (!hasData && !detail) {
    tip.append(el("p", "tip-rows secondary", "No data"));
    return;
  }
  const rows = el("ul", "tip-rows");
  const minutes: DayDetail["m"] = detail?.m.length ? detail.m : [["operational", 1440]];
  if (detail && detail.m.length === 0) rows.append(el("li", "", detail.t));
  else {
    for (const [state, spent] of minutes) {
      const row = el("li", "");
      row.append(
        swatch(state),
        el("span", "", componentStatusLabels[state]),
        el("span", "num tip-value", hm(spent)),
      );
      rows.append(row);
    }
  }
  tip.append(rows);
  if (!detail?.n.length) return;
  const list = el("ul", "tip-incidents");
  for (const [title, start, end, state] of detail.n) {
    const span = end
      ? `${when(start, day)} to ${when(end, day)} UTC, ${hm((Date.parse(end) - Date.parse(start)) / 60_000)}`
      : `Since ${when(start, day)} UTC`;
    const text = el("span", "");
    text.append(el("span", "tip-title", title), el("span", "tip-when num", span));
    const item = el("li", "");
    item.append(swatch(state), text);
    list.append(item);
  }
  tip.append(list);
}

for (const strip of document.querySelectorAll<HTMLElement>("[data-strip]")) {
  const { start = "", count = "0", first = "0", name = "" } = strip.dataset;
  const details = JSON.parse(strip.dataset.days ?? "{}") as Record<string, DayDetail>;
  const svg = strip.querySelector("svg");
  const cursor = strip.querySelector<SVGRectElement>("[data-strip-cursor]");
  const wrap = strip.parentElement;
  const tip = wrap?.querySelector<HTMLElement>("[data-strip-tip]");
  const live = wrap?.querySelector<HTMLElement>("[data-strip-live]");
  const last = Number(count) - 1;
  let index = last;

  const text = (i: number) => {
    const what = details[i]?.t ?? (i >= Number(first) ? "Operational" : "No data");
    return `${dayLabel(dayAt(start, i))}: ${what}`;
  };
  const show = (i: number, keyboard: boolean) => {
    index = Math.max(0, Math.min(last, i));
    cursor?.setAttribute("x", String(index * STEP - 1));
    if (keyboard) cursor?.removeAttribute("hidden");
    else cursor?.setAttribute("hidden", "");
    if (tip && svg && wrap) {
      fill(tip, dayAt(start, index), details[index], index >= Number(first));
      tip.hidden = false;
      const offset = svg.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
      // Keep the popover over the card: near today it would run past the right edge.
      const room = wrap.getBoundingClientRect().width - tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(offset + index * STEP - 40, room))}px`;
    }
    if (keyboard && live) live.textContent = text(index);
  };
  const hide = () => {
    if (tip) tip.hidden = true;
    cursor?.setAttribute("hidden", "");
  };

  // A click focuses the strip too, but only keyboard focus (focus-visible) opens the popover
  // and keeps it open; a pointer's popover follows the pointer and closes when it leaves.
  const keyboardFocus = () => document.activeElement === strip && strip.matches(":focus-visible");
  strip.addEventListener("focus", () => {
    if (keyboardFocus()) show(index, true);
  });
  strip.addEventListener("blur", hide);
  strip.addEventListener("keydown", (event) => {
    const moves: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(next, true);
  });
  svg?.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    show(Math.floor((event.clientX - box.left) / STEP), false);
  });
  svg?.addEventListener("pointerleave", () => {
    if (!keyboardFocus()) hide();
  });
  strip.setAttribute(
    "aria-label",
    `${name}, the last ${count} days. Use the arrow keys to read each day.`,
  );
}
