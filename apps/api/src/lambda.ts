import { handle } from "hono/aws-lambda";
import { createApp } from "./app.ts";
import { createDeps } from "./deps.ts";

export const handler = handle(createApp(createDeps()));
