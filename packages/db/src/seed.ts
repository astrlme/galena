// Development data for `pnpm dev`: one workspace, one page, three components.
// Fixed IDs make it safe to run on every start.
import { componentId, pageId, workspaceId } from "@galena/contracts";
import { createDb } from "./client.ts";
import { component, page, pageComponent, workspace } from "./schema/index.ts";

const acme = workspaceId.parse("01920000-0000-7000-8000-000000000001");
const statusPage = pageId.parse("01920000-0000-7000-8000-000000000002");
const components = [
  { id: "01920000-0000-7000-8000-000000000011", name: "API" },
  { id: "01920000-0000-7000-8000-000000000012", name: "Dashboard" },
  { id: "01920000-0000-7000-8000-000000000013", name: "Webhooks" },
].map((c, position) => ({ ...c, id: componentId.parse(c.id), position }));

const { db, close } = createDb({
  kind: "postgres",
  url: process.env.DATABASE_URL ?? "postgres://galena:galena@localhost:5432/galena",
});
try {
  await db.transaction(async (tx) => {
    await tx.insert(workspace).values({ id: acme, name: "Acme" }).onConflictDoNothing();
    await tx
      .insert(page)
      .values({ id: statusPage, workspaceId: acme, slug: "acme", name: "Acme status" })
      .onConflictDoNothing();
    await tx
      .insert(component)
      .values(components.map((c) => ({ ...c, workspaceId: acme })))
      .onConflictDoNothing();
    await tx
      .insert(pageComponent)
      .values(
        components.map((c, i) => ({
          id: `01920000-0000-7000-8000-00000000002${i + 1}`,
          workspaceId: acme,
          pageId: statusPage,
          componentId: c.id,
          position: c.position,
        })),
      )
      .onConflictDoNothing();
  });
  console.log("Seeded workspace Acme: page /acme with API, Dashboard and Webhooks.");
} finally {
  await close();
}
