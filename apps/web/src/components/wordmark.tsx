/** "galena" with its mark: a solid square touched at the top-right by a thin diagonal wire. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[19px] font-semibold leading-none">
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="6" width="12" height="12" fill="currentColor" />
        <path d="M14 6 L19 1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      galena
    </span>
  );
}
