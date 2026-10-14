import { queue } from "@trigger.dev/sdk";

/** trigger.dev's queues, one per lane family; jobs sharing a queue share its limit. */
export const queues = {
  incidents: queue({ name: "incidents", concurrencyLimit: 5 }),
  maintenance: queue({ name: "maintenance", concurrencyLimit: 5 }),
  // Known limit: one run at a time for the whole outbox. Each run rebuilds monitors.json from
  // the database, so running them in order means the newest committed state is written last.
  // Split per event type once other consumers make the queue busy.
  outbox: queue({ name: "outbox", concurrencyLimit: 1 }),
  // Known limit: one alert group at a time across every integration, so a group's firing and
  // resolve messages never race; a burst waits its turn. Key the queue by fingerprint if bursts grow.
  signals: queue({ name: "signals", concurrencyLimit: 1 }),
  slackApp: queue({ name: "slack-app", concurrencyLimit: 5 }),
  // One run at a time, so each publish reads the database after the one before it wrote.
  // `page.heartbeat` shares it, so it never stamps snapshot.json while a publish writes it.
  publisher: queue({ name: "publisher", concurrencyLimit: 1 }),
  // One build at a time; a queued run for an older version stops once newer HTML is out.
  builder: queue({ name: "builder", concurrencyLimit: 1 }),
  notify: queue({ name: "notify", concurrencyLimit: 5 }),
  // A few at a time: SES's send rate is 1 per second in the sandbox and 14 after that.
  email: queue({ name: "email", concurrencyLimit: 5 }),
  slack: queue({ name: "slack", concurrencyLimit: 10 }),
  webhook: queue({ name: "webhook", concurrencyLimit: 10 }),
};
