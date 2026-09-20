import { handle } from "hono/aws-lambda";
import { createApp } from "./app.ts";

export const handler = handle(createApp());
