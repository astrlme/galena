import { type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  expiryPartition,
  expiryKey as keyOf,
  type MemberId,
  type MonitorId,
  type MonitorsFile,
  type StoredExpiry,
  storedExpiry,
  type TlsCertificate,
  tlsCertificate,
  type WorkspaceId,
} from "@galena/contracts";
import { dueWarning } from "@galena/core";
import { type DomainLookup, registeredDomain } from "@galena/integrations/rdap";
import { writeBatches } from "./batch-write.ts";
import type { ExpiryWarningPayload } from "./email.ts";

const HOUR_MS = 3_600_000;
/** How often a domain is looked up: registries change expiry dates rarely. */
const LOOKUP_EVERY_MS = 24 * HOUR_MS;
/**
 * Lookups one run makes, oldest first, so a first run over many domains stays well inside the
 * function's 2 minutes (4 at a time, 8 s at most each); the rest wait for the next hour.
 */
const LOOKUPS_PER_RUN = 20;
/** Items outlive a few missed scans; a scan deletes what no monitor reaches any more. */
const TTL_SECONDS = 3 * 86_400;
/** Newest results read per monitor: two minutes of three regions. */
const RESULTS_READ = 6;
/** Monitors whose results are read at once, so a long list stays inside the table's capacity. */
const READ_CONCURRENCY = 10;
/**
 * How long a monitor that completes no handshake (down, say) keeps the certificate it last saw:
 * long enough to keep warning through an outage, short enough that one nothing checks fades.
 */
const KEEP_UNSEEN_MS = 7 * 24 * HOUR_MS;

export type ExpiryStore = {
  /**
   * The certificate expiring first among the monitor's newest results, if any of them completed
   * a handshake: regions served by different edges may see different certificates.
   */
  latestCertificate(monitorId: MonitorId): Promise<TlsCertificate | undefined>;
  expiries(workspaceId: WorkspaceId): Promise<StoredExpiry[]>;
  /** Writes the items whole, to expire a few days after `now`, and deletes the others named. */
  save(
    workspaceId: WorkspaceId,
    items: StoredExpiry[],
    remove: Pick<StoredExpiry, "kind" | "name">[],
    now: Date,
  ): Promise<void>;
};

export type ExpiryScanDeps = {
  /** The schedule's time, never the clock's. */
  now: Date;
  store: ExpiryStore;
  monitors: () => Promise<MonitorsFile["monitors"]>;
  lookUpDomains: (domains: string[]) => Promise<Map<string, DomainLookup>>;
  /** Wakes Aurora, so it is called only when a warning is due. */
  members: (workspaceId: WorkspaceId) => Promise<MemberId[]>;
  /** Starts one `notify.email` per member and warning, each with its key. */
  warn: (emails: { payload: WarningEmail; key: string }[]) => Promise<void>;
};
export type WarningEmail = { kind: "expiry"; memberId: MemberId; warning: ExpiryWarningPayload };

type ScannedMonitor = {
  id: MonitorId;
  host: string;
  url: URL;
  certificate: TlsCertificate | undefined;
};
export type ScanOutcome = {
  certificates: number;
  domains: number;
  lookedUp: number;
  warnings: number;
  removed: number;
};

/**
 * `send:{warningId}:{memberId}`: the warning id names the expiry date and threshold, so a new
 * date warns again; colons (an IPv6 host) would split the key, so they become dots.
 */
export const warningKey = (warning: ExpiryWarningPayload, member: MemberId) =>
  `send:expiry#${warning.kind}#${warning.name.replaceAll(":", ".")}#${Date.parse(warning.expiresAt)}#${warning.threshold}:${member}`;

/**
 * One scan: each HTTP monitor's newest certificate and each registered domain's expiry, stored
 * per workspace, and a warning email to every member of it for each threshold crossed. Reads
 * `monitors.json` and DynamoDB; Aurora only when a warning is due.
 */
export async function scanExpiries(deps: ExpiryScanDeps): Promise<ScanOutcome> {
  const monitors = (await deps.monitors()).flatMap((m) => {
    if (!m.http) return [];
    const url = new URL(m.http.url);
    return [{ id: m.id, workspaceId: m.workspaceId, host: url.hostname, url }];
  });
  const certificates: (TlsCertificate | undefined)[] = [];
  for (let i = 0; i < monitors.length; i += READ_CONCURRENCY) {
    const batch = monitors.slice(i, i + READ_CONCURRENCY);
    certificates.push(...(await Promise.all(batch.map((m) => deps.store.latestCertificate(m.id)))));
  }
  const byWorkspace = new Map<WorkspaceId, ScannedMonitor[]>();
  monitors.forEach(({ workspaceId, ...monitor }, i) => {
    const scanned = { ...monitor, certificate: certificates[i] };
    byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), scanned]);
  });

  const total: ScanOutcome = { certificates: 0, domains: 0, lookedUp: 0, warnings: 0, removed: 0 };
  for (const [workspaceId, own] of byWorkspace) {
    const outcome = await scanWorkspace(workspaceId, own, deps);
    for (const key of Object.keys(total) as (keyof ScanOutcome)[]) total[key] += outcome[key];
  }
  return total;
}

/** One workspace's expiries: its own items, warnings and members, whatever others watch. */
async function scanWorkspace(
  workspaceId: WorkspaceId,
  monitors: ScannedMonitor[],
  deps: ExpiryScanDeps,
): Promise<ScanOutcome> {
  const { now, store } = deps;
  const existing = await store.expiries(workspaceId);
  const before = new Map(existing.map((item) => [keyOf(item), item]));
  const next = new Map<string, StoredExpiry>();
  const put = (fields: Omit<StoredExpiry, "monitorIds" | "sent">, monitorId: MonitorId) => {
    const key = keyOf(fields);
    const { kind, name, expiresAt, issuer, checkedAt } = fields;
    next.set(key, {
      kind,
      name,
      expiresAt,
      issuer,
      checkedAt,
      monitorIds: [...new Set([...(next.get(key)?.monitorIds ?? []), monitorId])],
      sent: before.get(key)?.sent ?? null,
    });
  };

  // Certificates: the newest each monitor saw, the soonest expiry per host.
  for (const { id, certificate: seen } of monitors) {
    if (!seen) continue;
    const known = next.get(keyOf({ kind: "certificate", name: seen.host }));
    const fields = {
      kind: "certificate" as const,
      name: seen.host,
      expiresAt: seen.validTo,
      issuer: seen.issuer,
      checkedAt: now.toISOString(),
    };
    put(known?.expiresAt && known.expiresAt <= seen.validTo ? known : fields, id);
  }
  // An HTTPS monitor whose newest results had no handshake (down, say) keeps the certificate it
  // reached before for a while, unless a fresher reading of it came in above. One switched to
  // plain HTTP keeps none.
  for (const monitor of monitors) {
    if (monitor.certificate || monitor.url.protocol !== "https:") continue;
    for (const item of existing) {
      if (item.kind !== "certificate" || !item.monitorIds.includes(monitor.id)) continue;
      if (now.getTime() - Date.parse(item.checkedAt) > KEEP_UNSEEN_MS) continue;
      put(next.get(keyOf(item)) ?? item, monitor.id);
    }
  }

  // Domains: looked up once a day each, oldest first; a failed lookup keeps the last known expiry.
  const domainsOf = new Map<string, MonitorId[]>();
  for (const monitor of monitors) {
    const domain = registeredDomain(monitor.host);
    if (domain) domainsOf.set(domain, [...(domainsOf.get(domain) ?? []), monitor.id]);
  }
  const checkedAt = (domain: string) =>
    Date.parse(before.get(keyOf({ kind: "domain", name: domain }))?.checkedAt ?? "") || 0;
  const due = [...domainsOf.keys()]
    .filter((domain) => now.getTime() - checkedAt(domain) >= LOOKUP_EVERY_MS)
    .toSorted((a, b) => checkedAt(a) - checkedAt(b))
    .slice(0, LOOKUPS_PER_RUN);
  const lookups = due.length > 0 ? await deps.lookUpDomains(due) : new Map<string, DomainLookup>();
  for (const [domain, ids] of domainsOf) {
    const known = before.get(keyOf({ kind: "domain", name: domain }));
    const lookup = lookups.get(domain);
    const fresh = lookup?.status === "found";
    if (!fresh && !known) continue; // never found yet: try again next hour
    const fields = {
      kind: "domain" as const,
      name: domain,
      expiresAt: fresh ? lookup.expiresAt : (known?.expiresAt ?? null),
      issuer: null,
      checkedAt: fresh ? now.toISOString() : (known?.checkedAt ?? now.toISOString()),
    };
    for (const id of ids) put(fields, id);
  }

  // Warnings: the most urgent threshold crossed, once per expiry date.
  const warnings: { item: StoredExpiry; warning: ExpiryWarningPayload }[] = [];
  for (const item of next.values()) {
    if (!item.expiresAt) continue;
    const threshold = dueWarning(item.expiresAt, item.sent, now);
    if (threshold === null) continue;
    const { kind, name, issuer, expiresAt } = item;
    warnings.push({ item, warning: { kind, name, issuer, expiresAt, threshold } });
  }
  if (warnings.length > 0) {
    const team = await deps.members(workspaceId);
    // Known limit: started before the item records them, so a run that dies in between warns
    // again: on its retry if that comes after the queue's 5-minute deduplication (a Lambda
    // timeout is redelivered after the visibility timeout), else next hour. A lost warning would
    // be worse.
    await deps.warn(
      warnings.flatMap(({ warning }) =>
        team.map((memberId) => ({
          payload: { kind: "expiry" as const, memberId, warning },
          key: warningKey(warning, memberId),
        })),
      ),
    );
    for (const { item, warning } of warnings) {
      next.set(keyOf(item), {
        ...item,
        sent: { expiresAt: warning.expiresAt, threshold: warning.threshold },
      });
    }
  }

  const gone = existing.filter((item) => !next.has(keyOf(item)));
  await store.save(workspaceId, [...next.values()], gone, now);
  const items = [...next.values()];
  return {
    certificates: items.filter((item) => item.kind === "certificate").length,
    domains: items.filter((item) => item.kind === "domain").length,
    lookedUp: due.length,
    warnings: warnings.length,
    removed: gone.length,
  };
}

/** The store on the telemetry table: results under `MON#<id>`, expiries under each workspace. */
export function dynamoExpiryStore(doc: DynamoDBDocumentClient, table: string): ExpiryStore {
  return {
    async latestCertificate(monitorId) {
      const { Items = [] } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :results)",
          ExpressionAttributeValues: { ":pk": `MON#${monitorId}`, ":results": "R#" },
          ScanIndexForward: false,
          Limit: RESULTS_READ,
        }),
      );
      let soonest: TlsCertificate | undefined;
      for (const item of Items) {
        const parsed = tlsCertificate.safeParse(item.certificate);
        if (parsed.success && (!soonest || parsed.data.validTo < soonest.validTo)) {
          soonest = parsed.data;
        }
      }
      return soonest;
    },
    async expiries(workspaceId) {
      const items: StoredExpiry[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": expiryPartition(workspaceId) },
            ExclusiveStartKey: start,
          }),
        );
        for (const item of page.Items ?? []) {
          const parsed = storedExpiry.safeParse(item);
          if (parsed.success) items.push(parsed.data);
        }
        start = page.LastEvaluatedKey;
      } while (start);
      return items;
    },
    async save(workspaceId, items, remove, now) {
      const pk = expiryPartition(workspaceId);
      const ttl = Math.floor(now.getTime() / 1000) + TTL_SECONDS;
      await writeBatches(doc, table, [
        ...items.map((item) => ({ PutRequest: { Item: { pk, sk: keyOf(item), ...item, ttl } } })),
        ...remove.map((item) => ({ DeleteRequest: { Key: { pk, sk: keyOf(item) } } })),
      ]);
    },
  };
}
