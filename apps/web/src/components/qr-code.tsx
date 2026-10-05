import { light } from "@galena/ui/tokens";
import { encode } from "uqr";

/**
 * A QR code as one path of square modules. Always the light theme's ink on paper, whatever the
 * page's theme, since not every authenticator app reads an inverted code; the quiet zone is part
 * of the square.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 4 });
  const modules = data
    .flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])))
    .join("");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
      className="rounded-[6px]"
    >
      <rect width={size} height={size} fill={light.paper} />
      <path d={modules} fill={light.ink} />
    </svg>
  );
}
