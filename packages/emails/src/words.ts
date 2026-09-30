import type { Notice } from "@galena/contracts";

// Wording only an email needs; the rest of a notice's words are in @galena/contracts.

export const linkText = (n: Notice) =>
  n.kind.startsWith("maintenance_")
    ? `See ${n.page.name} status`
    : `Read the incident on ${n.page.name} status`;

export const footerText = (n: Notice) =>
  `You get these emails because you subscribed to updates from ${n.page.name} status.`;
