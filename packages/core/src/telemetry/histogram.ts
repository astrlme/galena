// A latency histogram with log-spaced buckets from 1 ms to 60 s. Summed histograms give the
// quantiles of everything they hold, which a day's p95 needs: averaging 24 hourly p95s doesn't.

const BUCKETS = 50;
const MIN_MS = 1;
const MAX_MS = 60_000;
/** Each bucket is this many times wider at its top than at its bottom (about 1.246). */
const RATIO = (MAX_MS / MIN_MS) ** (1 / BUCKETS);

/** Counts per bucket, `BUCKETS` long; bucket `i` holds `[RATIO^i, RATIO^(i+1))` ms. */
export type Histogram = number[];

/** The bucket a latency falls in; anything below 1 ms or above 60 s lands in the end buckets. */
const bucketOf = (ms: number) =>
  Math.min(BUCKETS - 1, Math.max(0, Math.floor(Math.log(ms / MIN_MS) / Math.log(RATIO))));

export function histogramOf(values: Iterable<number>): Histogram {
  const counts: Histogram = Array.from({ length: BUCKETS }, () => 0);
  for (const ms of values) counts[bucketOf(ms)] = (counts[bucketOf(ms)] ?? 0) + 1;
  return counts;
}

/** Both histograms' counts together: a day from its hours. */
export const mergeHistograms = (a: Histogram, b: Histogram): Histogram =>
  a.map((n, i) => n + (b[i] ?? 0));

/**
 * The `q` quantile (0.5 for the median, 0.95 for p95) by nearest rank, as the geometric middle
 * of its bucket: at most `sqrt(RATIO) − 1`, about 11.6%, from the exact value. Null when empty.
 */
export function quantileOf(histogram: Histogram, q: number): number | null {
  const total = histogram.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i] ?? 0;
    if (seen >= rank) return MIN_MS * RATIO ** (i + 0.5);
  }
  return MAX_MS;
}
