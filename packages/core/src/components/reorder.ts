import { err, ok, type Result } from "../result.ts";

/**
 * Positions for a new order. The request must name every current id exactly once, so a stale
 * screen can't drop or duplicate items; it gets `order_mismatch` and should reload.
 */
export function reorder<Id extends string>(
  current: readonly Id[],
  requested: readonly string[],
): Result<Map<Id, number>, "order_mismatch"> {
  const known = new Set<string>(current);
  const unique = new Set(requested);
  if (
    requested.length !== current.length ||
    unique.size !== requested.length ||
    requested.some((id) => !known.has(id))
  ) {
    return err(
      "order_mismatch",
      "The order must list every item exactly once. Reload the page and try again.",
    );
  }
  return ok(new Map(requested.map((id, position) => [id as Id, position])));
}
