import { idempotencyKeys } from "@trigger.dev/sdk";

/**
 * An idempotency key for a trigger made inside a task. A plain string there is scoped to the
 * calling run, so a second run (a backstop, a sweep, a retry from elsewhere) would trigger again.
 */
export const globalKey = (key: string) => idempotencyKeys.create(key, { scope: "global" });
