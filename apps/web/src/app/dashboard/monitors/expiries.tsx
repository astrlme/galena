"use client";

import { daysLeft } from "@galena/core";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../../lib/api.ts";
import { SHORT_MONTHS } from "../../../lib/time.ts";
import { Fact } from "./fact.tsx";

// Certificates and domains the hourly expiry scan watches: a monitor's page shows its own (Home's
// needs list shows the ones expiring soon).

export function useExpiries() {
  return useQuery({
    queryKey: ["expiries"],
    queryFn: () => unwrap(api.GET("/v1/expiries")),
    // The scan runs hourly.
    staleTime: 5 * 60_000,
  });
}

const dayCount = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/** A date with its year, in UTC; the reader's local time on hover. */
function Day({ iso }: { iso: string }) {
  const at = new Date(iso);
  return (
    <time dateTime={iso} title={at.toLocaleString()}>
      {at.getUTCDate()} {SHORT_MONTHS[at.getUTCMonth()]} {at.getUTCFullYear()}
    </time>
  );
}

/** "expires on 18 Nov 2026, in 10 days" or "expired on 8 Nov 2026". */
function Expires({ iso, now }: { iso: string; now: Date }) {
  if (Date.parse(iso) <= now.getTime()) {
    return (
      <>
        expired on <Day iso={iso} />
      </>
    );
  }
  return (
    <>
      expires on <Day iso={iso} />, in {dayCount(daysLeft(iso, now))}
    </>
  );
}

/** An HTTP monitor's certificate and domain, once the scan has seen them. */
export function ExpiryFacts({ monitorId, now }: { monitorId: string; now: Date }) {
  const expiries = useExpiries();
  const own = (expiries.data?.expiries ?? []).filter((e) => e.monitorIds.includes(monitorId));
  const certificate = own.find((e) => e.kind === "certificate");
  const domain = own.find((e) => e.kind === "domain");
  if (!certificate?.expiresAt && !domain) return null;
  return (
    <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
      {certificate?.expiresAt && (
        <Fact name="Certificate">
          {certificate.name} <Expires iso={certificate.expiresAt} now={now} />.
          {certificate.issuer ? ` Issued by ${certificate.issuer}.` : ""}
        </Fact>
      )}
      {domain && (
        <Fact name="Domain">
          {domain.expiresAt ? (
            <>
              {domain.name} <Expires iso={domain.expiresAt} now={now} />.
            </>
          ) : (
            `${domain.name}: its registry publishes no expiry date.`
          )}
        </Fact>
      )}
    </dl>
  );
}
