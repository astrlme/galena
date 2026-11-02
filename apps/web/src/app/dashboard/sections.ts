// The dashboard's six sections: daily work first, then everything that shapes the public page,
// then setup. A section is current for every page under `prefix`.
export const sections = [
  { key: "home", title: "Home", href: "/dashboard/", prefix: null },
  {
    key: "incidents",
    title: "Incidents",
    href: "/dashboard/incidents/",
    prefix: "/dashboard/incidents/",
  },
  {
    key: "monitors",
    title: "Monitors",
    href: "/dashboard/monitors/",
    prefix: "/dashboard/monitors/",
  },
  {
    key: "status-page",
    title: "Status page",
    href: "/dashboard/status-page/components/",
    prefix: "/dashboard/status-page/",
  },
  {
    key: "integrations",
    title: "Integrations",
    href: "/dashboard/integrations/",
    prefix: "/dashboard/integrations/",
  },
  {
    key: "settings",
    title: "Settings",
    href: "/dashboard/settings/",
    prefix: "/dashboard/settings/",
  },
] as const;

export type SectionKey = (typeof sections)[number]["key"];

/** What shapes the public page, under Status page. */
export const statusPageParts = [
  { title: "Components", href: "/dashboard/status-page/components/" },
  { title: "Maintenance", href: "/dashboard/status-page/maintenance/" },
  { title: "Subscribers", href: "/dashboard/status-page/subscribers/" },
  { title: "Internal page", href: "/dashboard/status-page/internal/" },
] as const;

export const isCurrent = (section: (typeof sections)[number], pathname: string) =>
  section.prefix === null ? pathname === section.href : pathname.startsWith(section.prefix);
