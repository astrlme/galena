const WIDTH = 96;
const HEIGHT = 24;

/**
 * One series as a 1.5 px `ink` line scaled to its own range, broken where a value is missing. It
 * is a picture of the trend only: `label` says the numbers, read out and shown on hover.
 */
export function Sparkline({
  values,
  label,
}: {
  values: readonly (number | null)[];
  label: string;
}) {
  const known = values.filter((v): v is number => v !== null);
  const min = Math.min(...known);
  const span = Math.max(...known) - min;
  const x = (i: number) => 1 + (i / Math.max(1, values.length - 1)) * (WIDTH - 2);
  // A flat series sits in the middle rather than on the floor.
  const y = (v: number) =>
    span === 0 ? HEIGHT / 2 : HEIGHT - 2 - ((v - min) / span) * (HEIGHT - 4);
  // One subpath per run of known values; a run of one is a dot.
  let path = "";
  values.forEach((v, i) => {
    if (v === null) return;
    const starts = i === 0 || values[i - 1] === null;
    const ends = i === values.length - 1 || values[i + 1] === null;
    path += `${starts ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    if (starts && ends) path += "h0.01";
  });
  return (
    <svg role="img" aria-label={label} width={WIDTH} height={HEIGHT} className="text-ink">
      <title>{label}</title>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
