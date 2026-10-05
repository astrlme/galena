// `GLN_DRAFT_TITLE=… pnpm --filter @galena/api draft:local`: a monitor's draft on the seeded
// workspace's API component, waiting for a person, for the dashboard's end-to-end tests (local
// development runs no autopilot). Prints the draft's id.
import { componentId, incidentId, incidentUpdateId, workspaceId } from "@galena/contracts";
import { createDb, incidentRepository } from "@galena/db";
import { v7 } from "uuid";
import { env } from "./env.ts";

if (env.GLN_STAGE !== "local" || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.GLN_DATABASE_URL)) {
  throw new Error("draft:local only runs against the local docker-compose database.");
}

// The seed's workspace and its API component.
const acme = workspaceId.parse("01920000-0000-7000-8000-000000000001");
const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const title = process.env.GLN_DRAFT_TITLE ?? "API is down";

const { db, close } = createDb({ kind: "postgres", url: env.GLN_DATABASE_URL });
try {
  const id = incidentId.parse(v7());
  const now = new Date();
  await incidentRepository(db).createOnce(
    {
      id,
      workspaceId: acme,
      title,
      impact: "major",
      visibility: "draft",
      source: "monitor",
      startedAt: now,
      dedupKey: `local:${id}`,
      approvalDeadline: new Date(now.getTime() + 10 * 60_000),
    },
    {
      update: {
        id: incidentUpdateId.parse(v7()),
        status: "investigating",
        body: "We're seeing failed checks on API from more than one region.",
        createdAt: now,
        createdByUserId: null,
      },
      stage: { status: "investigating", resolvedAt: null },
      components: [{ componentId: api, status: "major_outage" }],
      statusChange: { from: null, to: "investigating" },
    },
  );
  console.log(id);
} finally {
  await close();
}
