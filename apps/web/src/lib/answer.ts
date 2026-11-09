import type { paths } from "./api-schema.ts";

/** The JSON a GET on `path` answers with, from the API's own schema. */
export type Answer<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer T } } } };
}
  ? T
  : never;
