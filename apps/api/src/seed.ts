// Development data for `pnpm dev` and the E2E tests: an owner you can sign in as, workspace
// Acme, page /acme and three components. Fixed IDs make it safe to run on every start.
import { componentId, memberId, pageId, workspaceId } from "@galena/contracts";
import { createWorkspace, schema, workspaceExists } from "@galena/db";
import { createDeps } from "./deps.ts";
import { env } from "./env.ts";

// A published fixture, so this script refuses any database but the local one.
const LOCAL_OWNER = {
  name: "Local owner",
  email: "owner@example.com",
  password: "galena-local-owner",
};

if (env.GLN_STAGE !== "local" || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.GLN_DATABASE_URL)) {
  throw new Error("db:seed only runs against the local docker-compose database.");
}

const acme = workspaceId.parse("01920000-0000-7000-8000-000000000001");
const statusPage = pageId.parse("01920000-0000-7000-8000-000000000002");
const components = ["API", "Dashboard", "Webhooks"].map((name, position) => ({
  id: componentId.parse(`01920000-0000-7000-8000-00000000001${position + 1}`),
  workspaceId: acme,
  name,
  position,
}));

const { db, auth, close } = await createDeps();
try {
  if (!(await workspaceExists(db))) {
    const { user } = await auth.api.signUpEmail({ body: LOCAL_OWNER });
    await createWorkspace(db, {
      id: acme,
      name: "Acme",
      owner: { memberId: memberId.parse("01920000-0000-7000-8000-000000000003"), userId: user.id },
    });
  }
  const [owner] = await db.select().from(schema.member).limit(1);
  if (!owner) {
    throw new Error(
      "The local database has a workspace but no owner (it predates this seed). Reset it: docker compose down -v, then pnpm dev.",
    );
  }
  await db
    .insert(schema.page)
    .values({ id: statusPage, workspaceId: acme, slug: "acme", name: "Acme status" })
    .onConflictDoNothing();
  await db.insert(schema.component).values(components).onConflictDoNothing();
  await db
    .insert(schema.pageComponent)
    .values(
      components.map((c) => ({
        id: `01920000-0000-7000-8000-00000000002${c.position + 1}`,
        workspaceId: acme,
        pageId: statusPage,
        componentId: c.id,
        position: c.position,
      })),
    )
    .onConflictDoNothing();
  console.log(`Seeded Acme. Sign in at http://localhost:3000/sign-in/ as ${LOCAL_OWNER.email}.`);
} finally {
  await close();
}
