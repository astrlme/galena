// Where the subscription forms and links land. Static like every other page; the API answers
// each form post with a 303 to one of these.
export const subscriptionPages = {
  sent: {
    title: "Check your inbox",
    text: "If the address can get updates, a link to confirm is on its way. Nothing is sent until you confirm.",
  },
  "bad-address": {
    title: "That doesn't look like an email address",
    text: "Go back, check the address and try again.",
  },
  confirmed: {
    title: "You're subscribed",
    text: "You'll get an email when an incident or maintenance is posted. Every email has a one-click unsubscribe.",
  },
  "bad-link": {
    title: "This link doesn't work anymore",
    text: "Confirmation links last 7 days. Subscribe again from the status page to get a new one.",
  },
  unsubscribe: { title: "Unsubscribe", text: "" },
  unsubscribed: {
    title: "You're unsubscribed",
    text: "You won't get any more email from this page. Subscribe again any time.",
  },
} as const;
export type SubscriptionState = keyof typeof subscriptionPages;
