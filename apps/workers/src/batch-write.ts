import { setTimeout as sleep } from "node:timers/promises";
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

type WriteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];

/**
 * Puts and deletes in batches of 25. What a batch couldn't write comes back as
 * `UnprocessedItems` on a success, which the SDK doesn't retry: back off with full jitter and
 * send the rest, then give up so the job's own retry starts over.
 */
export async function writeBatches(
  doc: DynamoDBDocumentClient,
  table: string,
  requests: WriteRequest[],
) {
  for (let i = 0; i < requests.length; i += 25) {
    let batch = requests.slice(i, i + 25);
    for (let attempt = 0; batch.length > 0; attempt++) {
      if (attempt === 5) throw new Error("DynamoDB kept refusing writes; the job retries.");
      if (attempt > 0) await sleep(Math.random() * 100 * 2 ** attempt);
      const { UnprocessedItems } = await doc.send(
        new BatchWriteCommand({ RequestItems: { [table]: batch } }),
      );
      batch = UnprocessedItems?.[table] ?? [];
    }
  }
}
