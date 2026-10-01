import { BlockedByGuardError } from "@galena/integrations/net";
import { expect, test } from "vitest";
import { isFinalSendError, RetryableSendError } from "./endpoints.ts";

test("only the guard's refusal ends a send; anything that may pass is retried", () => {
  expect(isFinalSendError(new BlockedByGuardError("Private and reserved addresses…"))).toBe(true);
  const resuming = Object.assign(new Error("resuming"), { name: "DatabaseResumingException" });
  for (const error of [
    new RetryableSendError("The endpoint answered HTTP 503."),
    resuming,
    new Error("socket hang up"),
    "a string",
  ]) {
    expect(isFinalSendError(error)).toBe(false);
  }
});
