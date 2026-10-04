import { expect, test } from "vitest";
import { suppressions } from "./ses-feedback.ts";

const bounce = (bounceType: string) =>
  JSON.stringify({
    eventType: "Bounce",
    mail: { messageId: "m-1" },
    bounce: { bounceType, bouncedRecipients: [{ emailAddress: "Ada <Ada@Example.com>" }] },
  });

test("a permanent bounce or a complaint suppresses the address; a transient bounce does not", () => {
  expect(suppressions(bounce("Permanent"))).toEqual(["ada@example.com"]);
  expect(suppressions(bounce("Transient"))).toEqual([]);
  expect(
    suppressions(
      JSON.stringify({
        eventType: "Complaint",
        complaint: { complainedRecipients: [{ emailAddress: "grace@example.com" }] },
      }),
    ),
  ).toEqual(["grace@example.com"]);
});

test("other SES events, and messages that are not JSON, are ignored", () => {
  expect(suppressions(JSON.stringify({ eventType: "Delivery", delivery: {} }))).toEqual([]);
  expect(suppressions("not json")).toEqual([]);
});
