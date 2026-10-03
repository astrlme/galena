/**
 * "galena" with its mark, the cleaved crystal: a square with a 45° channel cutting a triangle off
 * its bottom-left corner. Below 24 px the pixel-drawn 16 px cut stays sharp; the master blurs.
 */
export function Wordmark({ size = 24, markOnly = false }: { size?: number; markOnly?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[9px] text-[19px] font-semibold leading-none">
      {size < 24 ? (
        <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M1 1 L15 1 L15 15 L10 15 L10 14 L9 14 L9 13 L8 13 L8 12 L7 12 L7 11 L6 11 L6 10 L5 10 L5 9 L4 9 L4 8 L3 8 L3 7 L2 7 L2 6 L1 6 Z M1 9 L2 9 L2 10 L3 10 L3 11 L4 11 L4 12 L5 12 L5 13 L6 13 L6 14 L7 14 L7 15 L1 15 Z"
          />
        </svg>
      ) : (
        <svg aria-hidden="true" width={size} height={size} viewBox="0 0 240 240">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M220 220 L152.43 220 L20 87.57 L20 20 L220 20 Z M110 220 L20 220 L20 130 Z"
          />
        </svg>
      )}
      <span className={markOnly ? "sr-only" : undefined}>galena</span>
    </span>
  );
}
