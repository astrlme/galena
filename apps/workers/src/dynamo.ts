import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { env } from "./env.ts";

// DynamoDB Local takes any credentials; in AWS stages, those of the function's role.
const endpoint =
  env.GLN_DYNAMODB_ENDPOINT ?? (env.GLN_DB_CLUSTER_ARN ? undefined : "http://localhost:8000");

/** The telemetry table's client, shared by the jobs that read or roll up what the evaluator wrote. */
export const telemetryDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    endpoint
      ? {
          endpoint,
          region: env.GLN_HOME_REGION,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : { region: env.GLN_HOME_REGION },
  ),
);
