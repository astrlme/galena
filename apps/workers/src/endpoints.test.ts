import { eventId, type Notice, webhookEndpointId } from "@galena/contracts";
import { laneOf } from "@galena/integrations/jobs";
import { v7 } from "uuid";
import { expect, test } from "vitest";
import { attemptKey, type EndpointPayload } from "./endpoints.ts";

test("each later attempt has a key of its own, in the lane of the delivery's first send", () => {
  const event = eventId.parse(v7());
  const endpointId = webhookEndpointId.parse(v7());
  const third: EndpointPayload = {
    endpointId,
    notice: { eventId: event } as Notice,
    attempt: 3,
  };
  expect(attemptKey(third)).toBe(`send:${event}:${endpointId}:3`);
  expect(attemptKey({ ...third, attempt: 4 })).not.toBe(attemptKey(third));
  const first = `send:${event}:${endpointId}`;
  for (const job of ["notify.webhook", "notify.slack"]) {
    expect(laneOf(job, attemptKey(third))).toBe(laneOf(job, first));
  }
});
