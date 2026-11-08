import { useLayoutEffect, useState } from "react";

/** Below 640 px: where sheets come from the bottom and side panels give way to them. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );
  useLayoutEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = (e: MediaQueryListEvent | MediaQueryList) => setMobile(e.matches);
    sync(mq);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}
