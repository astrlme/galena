import { expect, test } from "vitest";
import { AuthError, authFailure } from "./api.ts";

test("a wrong password or code reads as a mismatch; rate limits and outages say what happened", () => {
  const mismatch = "That code didn't match.";
  expect(authFailure(new AuthError("Invalid password", 400), mismatch)).toBe(mismatch);
  expect(authFailure(new AuthError("Invalid code", 401), mismatch)).toBe(mismatch);
  expect(authFailure(new AuthError("Too many requests", 429), mismatch)).toBe(
    "Too many attempts. Wait a minute, then try again.",
  );
  for (const failure of [new AuthError("Internal", 500), new TypeError("Failed to fetch")]) {
    expect(authFailure(failure, mismatch)).toBe("Couldn't check that. Try again in a minute.");
  }
});
