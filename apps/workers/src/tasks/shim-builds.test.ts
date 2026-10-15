import { expect, test, vi } from "vitest";

const sent = vi.hoisted(() => [] as { input: unknown }[]);
const triggered = vi.hoisted(() => [] as string[]);
vi.mock("@aws-sdk/client-sqs", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-sqs")>()),
  SQSClient: class {
    async send(command: { input: unknown }) {
      sent.push(command);
      return {};
    }
  },
}));
vi.mock("@trigger.dev/sdk", async (original) => ({
  ...(await original<typeof import("@trigger.dev/sdk")>()),
  tasks: { trigger: async (task: string) => triggered.push(task) },
}));
vi.mock("./keys.ts", () => ({ globalKey: async (key: string) => key }));
vi.stubEnv("GLN_BUILDS_QUEUE_URL", "https://sqs.eu-central-1.amazonaws.com/1/builds.fifo");
await import("./shim.ts");
const { engine } = await import("../engine.ts");

test("with a builds queue, trigger.dev hands HTML builds to AWS and keeps every other job", async () => {
  await engine().trigger("page.rebuild-html", { version: 7 }, { idempotencyKey: "html:7" });
  await engine().trigger("page.publish", { version: 7 }, { idempotencyKey: "pub:7" });
  expect(sent.map((c) => c.input)).toEqual([
    expect.objectContaining({
      QueueUrl: "https://sqs.eu-central-1.amazonaws.com/1/builds.fifo",
      MessageGroupId: "builder",
    }),
  ]);
  expect(triggered).toEqual(["page.publish"]);
});
