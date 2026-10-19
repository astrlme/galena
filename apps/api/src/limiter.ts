/**
 * At most `max` per key in any `windowMs`, counted in this process's memory: a first line in front
 * of the database, so one network or one hook URL can't make every request query it.
 * Known limit: each API instance counts on its own, so the ceiling is `max` times the instances
 * running; the API Gateway throttle bounds those.
 */
export function createLimiter({
  max,
  windowMs,
  maxKeys = 10_000,
  now = Date.now,
}: {
  max: number;
  windowMs: number;
  /** Keys held at once; past it, the one seen longest ago is forgotten. */
  maxKeys?: number;
  now?: () => number;
}): (key: string, count?: number) => boolean {
  const spent = new Map<string, number[]>();
  return (key, count = 1) => {
    const t = now();
    const recent = (spent.get(key) ?? []).filter((at) => t - at < windowMs);
    const allowed = recent.length + count <= max;
    if (allowed) recent.push(...Array<number>(count).fill(t));
    // Re-inserted so the map's order is the order keys were last seen.
    spent.delete(key);
    spent.set(key, recent);
    if (spent.size > maxKeys) spent.delete(spent.keys().next().value ?? key);
    return allowed;
  };
}
