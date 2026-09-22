import type { MemberRole } from "@galena/contracts";

// Known limit: hand-typed until a client is generated from /openapi.json.

export type Me = { userId: string; email: string; role: MemberRole; workspaceId: string };

/** The signed-in member, or null when nobody is signed in. */
export async function fetchMe(): Promise<Me | null> {
  const response = await fetch("/v1/me");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`GET /v1/me answered ${response.status}`);
  return (await response.json()) as Me;
}

/** POSTs JSON to a Better Auth endpoint and returns the parsed body, or throws with its message. */
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
