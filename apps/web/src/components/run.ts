import type { UseMutationResult } from "@tanstack/react-query";
import { toast } from "./ui/toast.tsx";

type Change = UseMutationResult<unknown, Error, () => Promise<unknown>>;

/**
 * Runs a call through a screen's one mutation, which shows any failure where the screen chose.
 * Resolves whether it succeeded, so a form knows to close; `done` is the toast on success.
 */
export const runWith =
  (change: Change) =>
  (call: () => Promise<unknown>, done?: string): Promise<boolean> =>
    new Promise((resolve) =>
      change.mutate(call, {
        onSuccess: () => {
          if (done) toast(done);
          resolve(true);
        },
        onError: () => resolve(false),
      }),
    );
