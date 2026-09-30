import { createDb, suppressSubscriber } from "@galena/db";
import { z } from "zod";
import { env } from "./env.ts";

// SES reports bounces and complaints through the configuration set to SNS, which invokes this.
// A permanent bounce or a complaint suppresses the address, so it is never mailed again.

const recipients = z.array(z.object({ emailAddress: z.string() }));
const sesEvent = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal("Bounce"),
    bounce: z.object({ bounceType: z.string(), bouncedRecipients: recipients }),
  }),
  z.object({
    eventType: z.literal("Complaint"),
    complaint: z.object({ complainedRecipients: recipients }),
  }),
]);

/** The addresses an SES event says to stop mailing; transient bounces say nothing. */
export function suppressions(message: string): string[] {
  const parsed = sesEvent.safeParse(JSON.parse(message));
  if (!parsed.success) return [];
  const event = parsed.data;
  const found =
    event.eventType === "Complaint"
      ? event.complaint.complainedRecipients
      : event.bounce.bounceType === "Permanent"
        ? event.bounce.bouncedRecipients
        : [];
  // SES may write "Name <address>"; we store bare, lower-cased addresses.
  return found.map((r) => (/<([^>]+)>/.exec(r.emailAddress)?.[1] ?? r.emailAddress).toLowerCase());
}

let db: ReturnType<typeof createDb>["db"] | undefined;

export async function handler(event: { Records: Array<{ Sns: { Message: string } }> }) {
  if (!env.GLN_DB_CLUSTER_ARN || !env.GLN_DB_SECRET_ARN || !env.AWS_REGION) {
    throw new Error("SES feedback needs the Data API: GLN_DB_CLUSTER_ARN and GLN_DB_SECRET_ARN.");
  }
  db ??= createDb({
    kind: "data-api",
    region: env.AWS_REGION,
    resourceArn: env.GLN_DB_CLUSTER_ARN,
    secretArn: env.GLN_DB_SECRET_ARN,
    database: env.GLN_DB_NAME,
  }).db;
  for (const record of event.Records) {
    for (const address of suppressions(record.Sns.Message)) {
      const rows = await suppressSubscriber(db, address);
      // The count only: addresses never go to the logs.
      console.info("ses.feedback suppressed", { rows });
    }
  }
}
