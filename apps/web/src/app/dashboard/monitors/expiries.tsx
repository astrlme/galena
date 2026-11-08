"use client";

import { EXPIRY_THRESHOLDS, type Expiry, expiryKey, expirySubjects } from "@galena/contracts";
import { daysLeft } from "@galena/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Loading } from "../../../components/ui/loading.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { SHORT_MONTHS } from "../../../lib/time.ts";
import { Fact } from "./fact.tsx";

// Certificates and domains the hourly expiry scan watches: Home lists the ones expiring soon,
// a monitor's page shows its own.

const DAY_MS = 86_400_000;
/** Home lists what members are warned about: from the first warning on. */
const SOON_DAYS = EXPIRY_THRESHOLDS[0];

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

/** Home's list of certificates and domains expiring within 30 days, soonest first. */
export function ExpiringSoon({ now }: { now: Date }) {
  const expiries = useExpiries();
  if (expiries.isPending) {
    return <Loading label="Loading expiries" rows={1} framed={false} className="mt-3" />;
  }
  if (expiries.isError) {
    return <p className="py-3 text-[14px]">{expiries.error.message}</p>;
  }
  const soon = expiries.data.expiries.filter(
    (e): e is Expiry & { expiresAt: string } =>
      e.expiresAt !== null && Date.parse(e.expiresAt) - now.getTime() <= SOON_DAYS * DAY_MS,
  );
  if (soon.length === 0) {
    return (
      <p className="py-3 text-[14px] text-slate">
        Nothing expires in the next {dayCount(SOON_DAYS)}.
      </p>
    );
  }
  return (
    <ul>
      {soon.map((e) => {
        const passed = Date.parse(e.expiresAt) <= now.getTime();
        return (
          <li key={expiryKey(e)} className="border-b border-mist py-2 tabular-nums">
            <Link
              href={`/dashboard/monitors/view/?id=${e.monitorIds[0]}`}
              className="text-[14px] underline-offset-2 [overflow-wrap:anywhere] hover:underline"
            >
              {expirySubjects[e.kind](e.name)}{" "}
              {passed ? "expired" : `expires in ${dayCount(daysLeft(e.expiresAt, now))}`}
            </Link>
            <p className="text-[14px] text-slate">
              On <Day iso={e.expiresAt} />.{e.issuer ? ` Issued by ${e.issuer}.` : ""}
            </p>
          </li>
        );
      })}
    </ul>
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
