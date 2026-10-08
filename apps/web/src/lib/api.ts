import createClient from "openapi-fetch";
import type { paths } from "./api-schema.ts";

/** The demo build answers from sample data in the browser; other builds never load it. */
export const demo = process.env.GLN_SITE === "demo";
const send = demo
  ? async (request: Request) => (await import("./demo/fetch.ts")).demoFetch(request)
  : (request: Request) => fetch(request);

/** Typed client generated from the API's /openapi.json; same origin, so no host. */
export const api = createClient<paths>({ baseUrl: "", fetch: send });

/** The data of an API call, or an Error carrying the problem's detail for the page to show. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (error !== undefined || !response.ok) {
    const detail = (error as { detail?: string } | undefined)?.detail;
    throw new Error(detail ?? `The request failed with ${response.status}. Try again.`);
  }
  return data as T;
}

/** GETs a Better Auth endpoint (not in /openapi.json) and returns the parsed body. */
export async function authGet<T>(path: string): Promise<T> {
  const response = await send(new Request(`/auth/${path}`));
  if (!response.ok) throw new Error(`The request failed with ${response.status}. Try again.`);
  return (await response.json()) as T;
}

/** A failed Better Auth call; the status tells a wrong answer from a busy or broken server. */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** What to tell the person: `mismatch` for a wrong password or code, otherwise why it failed. */
export function authFailure(error: unknown, mismatch: string): string {
  // The demo's only failure is that it saves nothing, and its message says so.
  if (demo && error instanceof Error) return error.message;
  const status = error instanceof AuthError ? error.status : 0;
  if (status === 400 || status === 401) return mismatch;
  if (status === 429) return "Too many attempts. Wait a minute, then try again.";
  return "Couldn't check that. Try again in a minute.";
}

/** POSTs JSON to a Better Auth endpoint (not in /openapi.json) and returns the parsed body. */
export async function authPost<T>(path: string, body: unknown): Promise<T> {
  const response = await send(
    new Request(`/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    throw new AuthError(data.message ?? `Request failed with ${response.status}`, response.status);
  }
  return data;
}
