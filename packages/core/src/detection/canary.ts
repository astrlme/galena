/** Consecutive canary passes before an excluded probe region counts again. */
const PASSES_TO_RETURN = 3;

export type CanaryTrack = { excluded: boolean; passes: number };

/**
 * A probe region whose own canary check fails can't be trusted about anyone's endpoint, so it
 * leaves the quorum until its canary passes three times in a row.
 */
export function nextCanary(track: CanaryTrack, passed: boolean): CanaryTrack {
  if (!passed) return { excluded: true, passes: 0 };
  const passes = track.passes + 1;
  return { excluded: track.excluded && passes < PASSES_TO_RETURN, passes };
}
