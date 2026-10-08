import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { slackAppConfig } from "@galena/contracts";
import type { WorkflowEngine } from "@galena/core";
import { createDb, type DbConfig } from "@galena/db";
import { guard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { slackApi } from "@galena/integrations/slack";
import { configure, tasks } from "@trigger.dev/sdk";
import type { Deps } from "./app.ts";
import { createAuth } from "./auth.ts";
import { env } from "./env.ts";
import { targetGuard } from "./targets.ts";
import { dynamoTelemetry } from "./telemetry.ts";

/** Local: docker-compose Postgres and env values. AWS: the Data API, secrets from SSM. */
export async function createDeps(): Promise<Deps & { close: () => Promise<void> }> {
  const database: DbConfig =
    env.GLN_DB_CLUSTER_ARN && env.GLN_DB_SECRET_ARN && env.AWS_REGION
      ? {
          kind: "data-api",
          region: env.AWS_REGION,
          resourceArn: env.GLN_DB_CLUSTER_ARN,
          secretArn: env.GLN_DB_SECRET_ARN,
          database: env.GLN_DB_NAME,
        }
      : { kind: "postgres", url: env.GLN_DATABASE_URL };
  const { db, close } = createDb(database);

  const ssm = new SSMClient({});
  const parameter = async (name: string) => {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    if (!Parameter?.Value) throw new Error(`SSM parameter ${name} has no value.`);
    return Parameter.Value;
  };

  let secret = env.GLN_AUTH_SECRET;
  if (!secret && env.GLN_AUTH_SECRET_PARAM) secret = await parameter(env.GLN_AUTH_SECRET_PARAM);
  // Checked here, not in env.ts: the migration Lambda shares env.ts and has no auth secret.
  if (!secret && env.GLN_STAGE !== "local") {
    throw new Error("Outside local development, set GLN_AUTH_SECRET_PARAM (an SSM SecureString).");
  }
  if (!secret) {
    // Local only: a fresh secret per start signs everyone out.
    console.warn("GLN_AUTH_SECRET is not set; using a random secret until the API restarts.");
    secret = randomBytes(32).toString("hex");
  }
  // Written by the Web stack: the dashboard's CloudFront origin, which also serves the API.
  const baseURL = env.GLN_PUBLIC_URL_PARAM
    ? await parameter(env.GLN_PUBLIC_URL_PARAM)
    : env.GLN_PUBLIC_URL;

  const github =
    env.GLN_GITHUB_CLIENT_ID && env.GLN_GITHUB_CLIENT_SECRET
      ? { clientId: env.GLN_GITHUB_CLIENT_ID, clientSecret: env.GLN_GITHUB_CLIENT_SECRET }
      : undefined;
  const auth = createAuth({
    db,
    secret,
    baseURL,
    rateLimit: env.GLN_STAGE !== "local",
    ...(github ? { github } : {}),
  });

  const triggerKey =
    env.TRIGGER_SECRET_KEY ??
    (env.GLN_TRIGGER_SECRET_PARAM ? await parameter(env.GLN_TRIGGER_SECRET_PARAM) : undefined);
  // Without it every change would commit and then quietly never reach the workers.
  if (!triggerKey && env.GLN_STAGE !== "local") {
    throw new Error(
      "Outside local development, set GLN_TRIGGER_SECRET_PARAM (an SSM SecureString).",
    );
  }
  if (triggerKey) configure({ accessToken: triggerKey });

  let appKey =
    env.GLN_APP_KEY ?? (env.GLN_APP_KEY_PARAM ? await parameter(env.GLN_APP_KEY_PARAM) : undefined);
  if (!appKey && env.GLN_STAGE !== "local") {
    throw new Error("Outside local development, set GLN_APP_KEY_PARAM (an SSM SecureString).");
  }
  appKey ??= LOCAL_APP_KEY;

  const originSecret = env.GLN_ORIGIN_SECRET_PARAM
    ? await parameter(env.GLN_ORIGIN_SECRET_PARAM)
    : undefined;

  // Made once for first-run setup. Without it, setup is refused and everything else works.
  const setupToken = env.GLN_SETUP_TOKEN_PARAM
    ? await parameter(env.GLN_SETUP_TOKEN_PARAM).catch((error: unknown) => {
        if (error instanceof ParameterNotFound) return undefined;
        throw error;
      })
    : undefined;

  // Optional, like the setup token: without the Slack app's secrets its routes answer 404.
  const slackJson =
    env.GLN_SLACK_APP ??
    (env.GLN_SLACK_APP_PARAM
      ? await parameter(env.GLN_SLACK_APP_PARAM).catch((error: unknown) => {
          if (error instanceof ParameterNotFound) return undefined;
          throw error;
        })
      : undefined);
  const slackApp = slackJson ? slackAppConfig.safeParse(safeJson(slackJson)) : undefined;
  if (slackApp && !slackApp.success) {
    // Names the fields only: the value holds secrets.
    throw new Error(
      "The Slack app's secrets must be JSON with clientId, clientSecret and signingSecret.",
    );
  }

  // DynamoDB Local takes any credentials; AWS uses the function's role.
  const endpoint =
    env.GLN_DYNAMODB_ENDPOINT ?? (env.GLN_STAGE === "local" ? "http://localhost:8000" : undefined);
  const dynamo = new DynamoDBClient(
    endpoint
      ? {
          endpoint,
          region: "eu-central-1",
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {},
  );
  const telemetry = dynamoTelemetry(
    DynamoDBDocumentClient.from(dynamo),
    env.GLN_TELEMETRY_TABLE,
    env.GLN_PROBE_REGIONS,
  );
  return {
    db,
    auth,
    engine: triggerKey ? triggerDev : notConfigured,
    telemetry,
    targets: targetGuard(env.GLN_STAGE, env.GLN_ALLOW_LOOPBACK),
    keys: appKeys(appKey),
    publicUrl: baseURL,
    ...(originSecret ? { originSecret } : {}),
    setup: env.GLN_STAGE === "local" ? "open" : setupToken ? { token: setupToken } : {},
    ...(slackApp?.success ? { slack: { ...slackApp.data, api: slackApi({ guard }) } } : {}),
    // Locally the workers put mail in a directory, so subscribing always works.
    subscriptions: env.GLN_STAGE === "local" || Boolean(env.GLN_EMAIL_FROM),
    close,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const triggerDev: WorkflowEngine = {
  async trigger(task, payload, { idempotencyKey, delay, tags }) {
    await tasks.trigger(task, payload, {
      idempotencyKey,
      ...(delay ? { delay } : {}),
      ...(tags ? { tags } : {}),
    });
  },
};

const notConfigured: WorkflowEngine = {
  async trigger(task) {
    console.warn(`No trigger.dev secret key is set, so ${task} was not triggered.`);
  },
};
