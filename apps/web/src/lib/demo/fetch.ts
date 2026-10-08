import { demoData } from "./data.ts";

// The demo build's stand-in for the network: the dashboard's requests are answered here, in the
// browser, from sample data. Nothing is ever saved.

export const READ_ONLY = "This is a demo, so changes aren't saved.";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// `detail` for the API client, `message` for the Better Auth helpers.
const problem = (status: number, code: string, detail: string) =>
  new Response(
    JSON.stringify({ type: "about:blank", status, code, title: detail, detail, message: detail }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

/** Answers one request the way the API would, as of the moment it's asked. */
export async function demoFetch(request: Request): Promise<Response> {
  if (request.method !== "GET") return problem(403, "demo_read_only", READ_ONLY);
  const url = new URL(request.url);
  const data = demoData(new Date());
  const state = url.searchParams.get("state");
  const incidents = data.incidents
    .filter((i) => !state || (state === "open") === (i.resolvedAt === null))
    .map(({ updates, ...incident }) => incident);
  const routes: Record<string, unknown> = {
    "/v1/me": data.me,
    "/auth/get-session": data.session,
    "/auth/list-sessions": data.sessions,
    "/v1/components": data.components,
    "/v1/monitors": data.monitors,
    "/v1/monitors/telemetry": data.telemetry,
    "/v1/incidents": { incidents },
    "/v1/maintenances": data.maintenances,
    "/v1/subscribers": data.subscribers,
    "/v1/webhook-endpoints": data.webhookEndpoints,
    ...Object.fromEntries(data.incidents.map((i) => [`/v1/incidents/${i.id}`, i])),
  };
  const body = routes[url.pathname];
  return body === undefined
    ? problem(404, "not_found", `The demo has nothing at ${url.pathname}.`)
    : json(body);
}
