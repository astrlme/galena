// `built: false` sections render the shared placeholder page until their task lands.
export const sections = [
  { slug: "incidents", title: "Incidents", built: true },
  { slug: "maintenance", title: "Maintenance", built: true },
  { slug: "monitors", title: "Monitors", built: true },
  { slug: "components", title: "Components", built: true },
  { slug: "subscribers", title: "Subscribers", built: false },
  { slug: "settings", title: "Settings", built: false },
] as const;
