// The signal strip for keyboards and pointers: one focusable element per strip; arrow keys (and
// Home, End) move between days, the day is read out through a polite live region, and hover or
// focus shows the same words in a small popover. Nothing moves on its own.

const STEP = 6; // a 4 px mark and a 2 px gap
const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

function dayLabel(start: string, index: number) {
  const at = new Date(Date.parse(`${start}T00:00:00.000Z`) + index * 86_400_000);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

for (const strip of document.querySelectorAll<HTMLElement>("[data-strip]")) {
  const { start = "", count = "0", first = "0", name = "" } = strip.dataset;
  const notable = JSON.parse(strip.dataset.notable ?? "{}") as Record<string, string>;
  const svg = strip.querySelector("svg");
  const cursor = strip.querySelector<SVGRectElement>("[data-strip-cursor]");
  const tip = strip.parentElement?.querySelector<HTMLElement>("[data-strip-tip]");
  const live = strip.parentElement?.querySelector<HTMLElement>("[data-strip-live]");
  const last = Number(count) - 1;
  let index = last;

  const text = (i: number) => {
    const what = notable[i] ?? (i >= Number(first) ? "Operational" : "No data");
    return `${dayLabel(start, i)}: ${what}`;
  };
  const show = (i: number, speak: boolean) => {
    index = Math.max(0, Math.min(last, i));
    const words = text(index);
    cursor?.setAttribute("x", String(index * STEP - 1));
    cursor?.removeAttribute("hidden");
    if (tip && svg) {
      tip.textContent = words;
      tip.hidden = false;
      const offset = svg.getBoundingClientRect().left - strip.getBoundingClientRect().left;
      tip.style.left = `${Math.max(0, offset + index * STEP - 40)}px`;
    }
    if (speak && live) live.textContent = words;
  };
  const hide = () => {
    if (tip) tip.hidden = true;
    cursor?.setAttribute("hidden", "");
  };

  strip.addEventListener("focus", () => show(index, true));
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
    if (document.activeElement !== strip) hide();
  });
  strip.setAttribute(
    "aria-label",
    `${name}, the last ${count} days. Use the arrow keys to read each day.`,
  );
}
