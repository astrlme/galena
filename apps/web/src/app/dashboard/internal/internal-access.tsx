"use client";

import { useEffect, useState } from "react";
import { api, unwrap } from "../../../lib/api.ts";

/** Asks the API to let this browser in, then opens the internal page in its place. */
export function InternalAccess() {
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    unwrap(api.POST("/v1/internal-page/access"))
      .then(() => window.location.replace("/internal/"))
      .catch((error: Error) => setProblem(error.message));
  }, []);
  return (
    <p className="mt-6 text-[16px]" aria-live="polite">
      {problem ? <span className="font-semibold">{problem}</span> : "Opening the internal page"}
    </p>
  );
}
