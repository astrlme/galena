import createClient from "openapi-fetch";
import type { paths } from "./api-schema.ts";

/** Typed client generated from the API's /openapi.json; same origin, so no host. */
export const api = createClient<paths>({ baseUrl: "" });

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
  const response = await fetch(`/auth/${path}`);
  if (!response.ok) throw new Error(`The request failed with ${response.status}. Try again.`);
  return (await response.json()) as T;
}

/** POSTs JSON to a Better Auth endpoint (not in /openapi.json) and returns the parsed body. */
export async function authPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? `Request failed with ${response.status}`);
  return data;
}
