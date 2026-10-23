import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { sqsEngine } from "@galena/integrations/jobs/aws";
import { setEngine } from "./engine.ts";
import { engineEnv, setAppKey, setHeartbeatUrl } from "./env.ts";
import { sqsLambda } from "./lambda-host.ts";
import { errorFields, log } from "./log.ts";

const host = engineEnv();

/** The jobs function: every job but the HTML build, starting others through SQS and Scheduler. */
export const handler = sqsLambda(async (sqs) => {
  const ssm = new SSMClient({});
  const parameter = async (name: string) =>
    (
      await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
        abortSignal: AbortSignal.timeout(5_000),
      })
    ).Parameter?.Value;
  const key = await parameter(host.GLN_APP_KEY_PARAM);
  if (!key) throw new Error(`SSM parameter ${host.GLN_APP_KEY_PARAM} has no value.`);
  setAppKey(key);
  // Optional: without it there is no outside dead-man's switch, and a read that fails leaves it
  // off (which the switch then reports) instead of failing every job.
  if (host.GLN_HEARTBEAT_PARAM) {
    setHeartbeatUrl(
      await parameter(host.GLN_HEARTBEAT_PARAM).catch((error: unknown) => {
        if (!(error instanceof ParameterNotFound)) {
          log.error("heartbeat URL not read", errorFields(error));
        }
        return undefined;
      }),
    );
  }
  setEngine(
    sqsEngine({
      sqs,
      scheduler: new SchedulerClient({}),
      clock: { now: () => new Date() },
      queues: {
        jobs: { url: host.GLN_JOBS_QUEUE_URL, arn: host.GLN_JOBS_QUEUE_ARN },
        builds: { url: host.GLN_BUILDS_QUEUE_URL, arn: host.GLN_BUILDS_QUEUE_ARN },
      },
      schedules: {
        group: host.GLN_SCHEDULE_GROUP,
        roleArn: host.GLN_SCHEDULER_ROLE_ARN,
        deadLetterArn: host.GLN_SCHEDULE_DEAD_LETTER_ARN,
      },
    }),
  );
  // Job modules build their clients, with the app key, when they load: so only now.
  return (await import("./jobs/index.ts")).jobs;
});
