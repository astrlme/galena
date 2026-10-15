import { expect, test } from "vitest";
import { laneOf } from "./lanes.ts";
import { toRequest } from "./sqs.ts";

const queues = {
  jobs: { url: "https://sqs/jobs.fifo", arn: "arn:aws:sqs:eu-central-1:1:jobs.fifo" },
  builds: { url: "https://sqs/builds.fifo", arn: "arn:aws:sqs:eu-central-1:1:builds.fifo" },
};
const now = new Date("2026-10-15T10:00:00.000Z");
const incident = "01a1d4c2-0b6e-7f1a-9c3d-5e6f7a8b9c0d";

test("a job without a time is sent now, in its lane, deduplicated by its key", () => {
  const request = toRequest(
    "outbox.dispatch",
    { outboxId: "01a1" },
    { idempotencyKey: "outbox:01a1" },
    now,
    queues,
  );
  expect(request).toEqual({
    kind: "send",
    queueUrl: queues.jobs.url,
    groupId: "outbox",
    dedupId: expect.stringMatching(/^[0-9a-f]{64}$/),
    body: JSON.stringify({
      job: "outbox.dispatch",
      key: "outbox:01a1",
      payload: { outboxId: "01a1" },
    }),
  });
});

test("HTML builds go to the builds queue", () => {
  const request = toRequest(
    "page.rebuild-html",
    { version: 7 },
    { idempotencyKey: "html:7" },
    now,
    queues,
  );
  expect(request).toMatchObject({ kind: "send", queueUrl: queues.builds.url, groupId: "builder" });
});

test("a job for later becomes a one-time schedule, never early", () => {
  const key = `auto:${incident}`;
  const request = toRequest(
    "incident.autopilot",
    { incidentId: incident },
    { idempotencyKey: key, at: new Date("2026-10-15T10:10:00.200Z") },
    now,
    queues,
  );
  expect(request).toEqual({
    kind: "schedule",
    name: expect.stringMatching(/^[0-9a-f]{64}$/),
    at: "2026-10-15T10:10:01",
    queueArn: queues.jobs.arn,
    groupId: laneOf("incident.autopilot", key),
    body: JSON.stringify({ job: "incident.autopilot", key, payload: { incidentId: incident } }),
  });
});

test.each([
  ["now", now],
  ["in the past", new Date("2026-10-15T09:59:00.000Z")],
])("a job due %s is sent at once", (_, at) => {
  const request = toRequest(
    "maintenance.lifecycle",
    {},
    { idempotencyKey: "mnt:1:2:in_progress", at },
    now,
    queues,
  );
  expect(request.kind).toBe("send");
});

test("one job and key always get the same name; the same key on another job does not", () => {
  const name = (job: string, key: string) => {
    const request = toRequest(
      job,
      {},
      { idempotencyKey: key, at: new Date("2026-10-16T00:00:00Z") },
      now,
      queues,
    );
    return request.kind === "schedule" ? request.name : undefined;
  };
  const send = (job: string, key: string) => {
    const request = toRequest(job, {}, { idempotencyKey: key }, now, queues);
    return request.kind === "send" ? request.dedupId : undefined;
  };
  expect(name("incident.autopilot", "auto:1")).toBe(name("incident.autopilot", "auto:1"));
  expect(name("incident.autopilot", "auto:1")).toBe(send("incident.autopilot", "auto:1"));
  expect(name("incident.autopilot", "auto:1")).not.toBe(name("maintenance.lifecycle", "auto:1"));
});
