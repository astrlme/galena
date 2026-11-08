import { EXPIRY_THRESHOLDS, type ExpiryThreshold, type SentWarning } from "@galena/contracts";

const DAY_MS = 86_400_000;

/** Whole days left, a part day counting as one: 6.5 days left reads "7 days", like its warning. */
export function daysLeft(expiresAt: string, now: Date): number {
  return Math.ceil((Date.parse(expiresAt) - now.getTime()) / DAY_MS);
}

/**
 * The warning to send now, or null. Only the most urgent threshold crossed counts, so an
 * expiry first seen 10 days out gets one email, not two at once. Nothing once it has passed:
 * an expired certificate already fails its check.
 */
export function dueWarning(
  expiresAt: string,
  sent: SentWarning | null,
  now: Date,
): ExpiryThreshold | null {
  const left = Date.parse(expiresAt) - now.getTime();
  const due = EXPIRY_THRESHOLDS.findLast((days) => left <= days * DAY_MS);
  if (due === undefined || left <= 0) return null;
  if (sent?.expiresAt === expiresAt && sent.threshold <= due) return null;
  return due;
}
