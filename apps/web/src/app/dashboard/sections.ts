// Where everything in the dashboard lives: its six sections (daily work first, then everything
// that shapes the public page, then setup), Status page's parts, the letter G goes to each by,
// and each list page's main action, which C and the palette start. One table, so a move is one
// edit here.

/** A list page's main action: its button's name and the form it opens. */
type Action = { label: string; editor: string };
type Place = {
  title: string;
  href: string;
  /** Every page under it counts as in it; defaults to `href`. */
  prefix?: string;
  go?: string;
  action?: Action;
};

export const sections = [
  { key: "home", title: "Home", href: "/dashboard/", go: "h" },
  {
    key: "incidents",
    title: "Incidents",
    href: "/dashboard/incidents/",
    go: "i",
    action: { label: "Publish incident", editor: "incident:new" },
  },
  {
    key: "monitors",
    title: "Monitors",
    href: "/dashboard/monitors/",
    go: "m",
    action: { label: "Add monitor", editor: "monitor:new" },
  },
  {
    key: "status-page",
    title: "Status page",
    href: "/dashboard/status-page/components/",
    prefix: "/dashboard/status-page/",
    go: "s",
  },
  {
    key: "integrations",
    title: "Integrations",
    href: "/dashboard/integrations/",
    action: { label: "Add integration", editor: "integration:new" },
  },
  { key: "settings", title: "Settings", href: "/dashboard/settings/" },
] as const satisfies readonly (Place & { key: string })[];

export type SectionKey = (typeof sections)[number]["key"];

/** What shapes the public page, under Status page. */
export const statusPageParts = [
  {
    title: "Components",
    href: "/dashboard/status-page/components/",
    action: { label: "Add component", editor: "component:new" },
  },
  {
    title: "Maintenance",
    href: "/dashboard/status-page/maintenance/",
    action: { label: "Schedule window", editor: "maintenance:new" },
  },
  {
    title: "Subscribers",
    href: "/dashboard/status-page/subscribers/",
    action: { label: "Add destination", editor: "destination:new" },
  },
  { title: "Internal page", href: "/dashboard/status-page/internal/" },
] as const satisfies readonly Place[];

/** Every place, for lookups and the palette's "Go to". */
export const places: readonly Place[] = [...sections, ...statusPageParts];

/** Whether `pathname` is in `place`; Home is only itself. */
export const isCurrent = (place: Place, pathname: string) =>
  place.href === "/dashboard/"
    ? pathname === place.href
    : pathname.startsWith(place.prefix ?? place.href);

/** Where G then `letter` goes. */
export const goTarget = (letter: string) => places.find((p) => p.go === letter)?.href;

/** The main action of the list page at `pathname`, if it has one. */
export const actionAt = (pathname: string) =>
  places.find((p) => p.href === pathname && p.action)?.action;

/** Every main action, with the page it belongs to. */
export const actions = places.flatMap((p) => (p.action ? [{ ...p.action, href: p.href }] : []));
