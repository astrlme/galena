import { CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { expect, test } from "vitest";
import { sqsEngine } from "./sqs-engine.ts";

const queues = {
  jobs: { url: "https://sqs/jobs.fifo", arn: "arn:aws:sqs:eu-central-1:1:jobs.fifo" },
  builds: { url: "https://sqs/builds.fifo", arn: "arn:aws:sqs:eu-central-1:1:builds.fifo" },
};
const schedules = { group: "galena-dev-jobs", roleArn: "arn:aws:iam::1:role/scheduler" };
const now = new Date("2026-10-15T10:00:00.000Z");
const later = new Date("2026-10-15T10:10:00.000Z");

function setup({
  failed = [] as { Id: string; Code: string }[],
  scheduleError = undefined as Error | undefined,
} = {}) {
  const sent: object[] = [];
  const engine = sqsEngine({
    sqs: {
      send: async (command: object) => {
        sent.push(command);
        return command instanceof SendMessageBatchCommand ? { Failed: failed } : {};
      },
    },
    scheduler: {
      send: async (command: object) => {
        sent.push(command);
        if (scheduleError) throw scheduleError;
        return {};
      },
    },
    clock: { now: () => now },
    queues,
    schedules,
  } as Parameters<typeof sqsEngine>[0]);
  return { engine, sent };
}

const conflict = Object.assign(new Error("Schedule already exists."), {
  name: "ConflictException",
});

test("a job for now is one message on its queue, in its lane", async () => {
  const { engine, sent } = setup();
  await engine.trigger("outbox.dispatch", { outboxId: "01a1" }, { idempotencyKey: "outbox:01a1" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(SendMessageCommand);
  expect((sent[0] as SendMessageCommand).input).toEqual({
    QueueUrl: queues.jobs.url,
    MessageGroupId: "outbox",
    MessageDeduplicationId: expect.stringMatching(/^[0-9a-f]{64}$/),
    MessageBody: expect.stringContaining('"key":"outbox:01a1"'),
  });
});

test("a job for later is a one-time schedule that deletes itself once it has sent", async () => {
  const { engine, sent } = setup();
  await engine.trigger(
    "incident.autopilot",
    { incidentId: "i1" },
    { idempotencyKey: "auto:i1", at: later },
  );
  expect(sent[0]).toBeInstanceOf(CreateScheduleCommand);
  expect((sent[0] as CreateScheduleCommand).input).toEqual({
    GroupName: schedules.group,
    Name: expect.stringMatching(/^[0-9a-f]{64}$/),
    ScheduleExpression: "at(2026-10-15T10:10:00)",
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    Target: {
      Arn: queues.jobs.arn,
      RoleArn: schedules.roleArn,
      Input: expect.stringContaining('"key":"auto:i1"'),
      SqsParameters: { MessageGroupId: expect.any(String) },
    },
  });
});

test("a schedule that already exists counts as scheduled", async () => {
  const { engine } = setup({ scheduleError: conflict });
  await expect(
    engine.trigger("incident.autopilot", {}, { idempotencyKey: "auto:i1", at: later }),
  ).resolves.toBeUndefined();
});

test("any other refusal from Scheduler fails the trigger", async () => {
  const { engine } = setup({
    scheduleError: Object.assign(new Error("No."), { name: "ValidationException" }),
  });
  await expect(
    engine.trigger("incident.autopilot", {}, { idempotencyKey: "auto:i1", at: later }),
  ).rejects.toThrow("No.");
});

test("many jobs go ten to a batch; those for later are scheduled one by one", async () => {
  const { engine, sent } = setup();
  const jobs = Array.from({ length: 23 }, (_, i) => ({
    payload: { i },
    options: { idempotencyKey: `send:e:${i}`, ...(i < 2 ? { at: later } : {}) },
  }));
  await engine.triggerAll("notify.email", jobs);
  const batches = sent.filter((c) => c instanceof SendMessageBatchCommand);
  expect(batches.map((b) => b.input.Entries?.length)).toEqual([10, 10, 1]);
  expect(sent.filter((c) => c instanceof CreateScheduleCommand)).toHaveLength(2);
});

test("a batch with a refused message fails, so the caller tries again", async () => {
  const { engine } = setup({ failed: [{ Id: "3", Code: "InternalError" }] });
  await expect(
    engine.triggerAll("notify.email", [{ payload: {}, options: { idempotencyKey: "send:e:1" } }]),
  ).rejects.toThrow("InternalError");
});
