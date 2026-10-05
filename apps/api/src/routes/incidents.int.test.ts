import { componentId, incidentId, incidentUpdateId, workspaceId } from "@galena/contracts";
import { incidentRepository, schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, like, sql } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type Triggered, testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

type View = {
  id: string;
  title: string;
  status: string;
  impact: string;
  resolvedAt: string | null;
  components: { componentId: string; status: string }[];
  updates: { status: string; body: string }[];
};

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: Triggered[];
let owner: Session;
let api: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  triggered = built.triggered;
  close = built.close;
  owner = new Session(createApp(deps));
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(setup.status).toBe(201);
  api = ((await (await owner.call("/v1/components", { name: "API" })).json()) as { id: string }).id;
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const post = async (path: string, body: unknown, status = 201) => {
  const response = await owner.call(path, body);
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as View;
};
const open = async () =>
  ((await (await owner.call("/v1/incidents")).json()) as { incidents: View[] }).incidents;
const resolved = async () =>
  ((await (await owner.call("/v1/incidents?state=resolved")).json()) as { incidents: View[] })
    .incidents;

test("an incident is published, updated and resolved, and leaves the open list", async () => {
  const created = await post("/v1/incidents", {
    title: "Elevated API errors",
    impact: "major",
    body: "We're seeing errors on API from 3 regions.",
    components: [{ componentId: api, status: "partial_outage" }],
  });
  expect(created).toMatchObject({
    status: "investigating",
    impact: "major",
    resolvedAt: null,
    components: [{ componentId: api, status: "partial_outage" }],
    updates: [{ status: "investigating" }],
  });
  expect((await open()).map((i) => i.id)).toContain(created.id);

  const identified = await post(`/v1/incidents/${created.id}/updates`, {
    status: "identified",
    body: "We found the cause: a bad deploy. We're rolling it back.",
    impact: "critical",
    components: [{ componentId: api, status: "major_outage" }],
  });
  expect(identified).toMatchObject({
    status: "identified",
    impact: "critical",
    components: [{ componentId: api, status: "major_outage" }],
  });

  const done = await post(`/v1/incidents/${created.id}/updates`, {
    status: "resolved",
    body: "API has worked normally since 14:20 UTC.",
  });
  expect(done.status).toBe("resolved");
  expect(done.resolvedAt).not.toBeNull();
  // Components stay as they were: the update didn't send any.
  expect(done.components).toEqual([{ componentId: api, status: "major_outage" }]);
  expect(done.updates.map((u) => u.status)).toEqual(["resolved", "identified", "investigating"]);
  expect((await open()).map((i) => i.id)).not.toContain(created.id);
  expect((await resolved()).map((i) => i.id)).toContain(created.id);

  // Each change leaves its event in the outbox and hands it to the dispatcher.
  const events = await deps.db
    .select({ type: schema.outbox.eventType })
    .from(schema.outbox)
    .where(like(schema.outbox.eventType, "incident.%"))
    .orderBy(schema.outbox.createdAt);
  expect(events.map((e) => e.type)).toEqual([
    "incident.created",
    "incident.updated",
    "incident.resolved",
  ]);
  expect(triggered.filter((t) => t.task === "outbox.dispatch").length).toBeGreaterThanOrEqual(3);
});

test("refuses a move the lifecycle doesn't have, and writes nothing", async () => {
  const created = await post("/v1/incidents", {
    title: "Backfilled",
    impact: "minor",
    status: "resolved",
    body: "API was slow between 09:00 and 09:20 UTC.",
  });
  await expectProblem(
    await owner.call(`/v1/incidents/${created.id}/updates`, {
      status: "investigating",
      body: "It's back.",
    }),
    409,
    "illegal_transition",
  );
  const after = (await (await owner.call(`/v1/incidents/${created.id}`)).json()) as View;
  expect(after.updates).toHaveLength(1);
});

test.each([
  [
    "a template placeholder left in",
    { body: "We're seeing {symptom} on API." },
    "unfilled_placeholder",
  ],
  ["raw HTML", { body: "<b>down</b>" }, "html_not_allowed"],
  [
    "a component that doesn't exist",
    { body: "Down.", components: [{ componentId: v7(), status: "major_outage" }] },
    "component_not_found",
  ],
])("refuses an incident with %s", async (_, overrides, code) => {
  await expectProblem(
    await owner.call("/v1/incidents", { title: "Nope", impact: "minor", ...overrides }),
    422,
    code,
  );
});

test("a person publishes or dismisses a monitor's draft before its deadline, once", async () => {
  const [ws] = await deps.db.select({ id: schema.workspace.id }).from(schema.workspace);
  const draft = async (title: string) => {
    const id = incidentId.parse(v7());
    const now = new Date();
    await incidentRepository(deps.db).createOnce(
      {
        id,
        workspaceId: workspaceId.parse(ws?.id),
        title,
        impact: "major",
        visibility: "draft",
        source: "monitor",
        startedAt: now,
        dedupKey: `mon:${v7()}`,
        approvalDeadline: new Date(now.getTime() + 600_000),
      },
      {
        update: {
          id: incidentUpdateId.parse(v7()),
          status: "investigating",
          body: "We're seeing failed checks on API.",
          createdAt: now,
          createdByUserId: null,
        },
        stage: { status: "investigating", resolvedAt: null },
        components: [{ componentId: componentId.parse(api), status: "major_outage" }],
      },
    );
    return id;
  };
  const decide = (id: string, decision: string) =>
    owner.call(`/v1/incidents/${id}/decision`, { decision });

  const published = await draft("API is down");
  const before = triggered.length;
  const view = await decide(published, "publish");
  expect(view.status, await view.clone().text()).toBe(200);
  expect(await view.json()).toMatchObject({ visibility: "published", approvalDeadline: null });
  // The change goes out like any other: an outbox row, then the dispatch.
  const [event] = await deps.db
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(sql`${schema.outbox.payload}->'data'->>'incidentId' = ${published}`);
  expect(event?.payload).toMatchObject({
    type: "incident.updated",
    data: { incidentId: published, visibility: "published" },
  });
  expect(triggered.slice(before).map((t) => t.delay ?? "now")).toEqual(["1m", "now"]);

  const dismissed = await draft("API is down again");
  expect(await (await decide(dismissed, "dismiss")).json()).toMatchObject({
    visibility: "dismissed",
  });
  // Already decided, by a person or by the deadline.
  await expectProblem(await decide(dismissed, "publish"), 409, "not_a_draft");
  const manual = await post("/v1/incidents", { title: "Slow", impact: "minor", body: "Looking." });
  await expectProblem(await decide(manual.id, "dismiss"), 409, "not_a_draft");
});

test("answers 404 for an incident that doesn't exist", async () => {
  await expectProblem(await owner.call(`/v1/incidents/${v7()}`), 404, "not_found");
});

test("a viewer may read incidents but not post them", async () => {
  await deps.db
    .update(schema.member)
    .set({ role: "viewer" })
    .where(eq(schema.member.role, "owner"));
  expect((await owner.call("/v1/incidents")).status).toBe(200);
  await expectProblem(
    await owner.call("/v1/incidents", { title: "x", impact: "minor", body: "x" }),
    403,
    "forbidden",
  );
});
