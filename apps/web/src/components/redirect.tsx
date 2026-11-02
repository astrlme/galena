"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Sends an old dashboard URL to its new place, query and hash included, so bookmarks and links in
 * emails sent before the move still land. A static export has no server to answer with a 301.
 */
export function Redirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`${to}${window.location.search}${window.location.hash}`);
  }, [router, to]);
  return null;
}
