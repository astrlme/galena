import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.ts";
import { createDeps } from "./deps.ts";

// Built once per container. A failed start (SSM or the public URL not there yet) is not cached,
// so the next request tries again instead of failing until the container is recycled.
let app: Promise<ReturnType<typeof handle>> | undefined;

export async function handler(event: LambdaEvent, context: LambdaContext) {
  app ??= createDeps().then((deps) => handle(createApp(deps)));
  try {
    return await (await app)(event, context);
  } catch (error) {
    app = undefined;
    throw error;
  }
}
