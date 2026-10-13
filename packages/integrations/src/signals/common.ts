import { createHash } from "node:crypto";
import { type Labels, MAX_LABEL_NAME, MAX_LABEL_VALUE, MAX_LABELS } from "@galena/contracts";

/** 22 url-safe characters that stand for `text`: the same group always gets the same one. */
export const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest().subarray(0, 16).toString("base64url");

/** The labels within `labels`' limits: the first 64 with a name up to 100, values cut to 1,000. */
export function trimLabels(sent: Readonly<Record<string, string>>): Labels {
  return Object.fromEntries(
    Object.entries(sent)
      .filter(([name]) => name.length > 0 && name.length <= MAX_LABEL_NAME)
      .slice(0, MAX_LABELS)
      .map(([name, value]) => [name, value.slice(0, MAX_LABEL_VALUE)]),
  );
}
