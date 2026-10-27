import { createRoute } from "@hono/zod-openapi";
import { setCookie } from "hono/cookie";
import { type App, type Deps, fail, requireRole } from "../http.ts";
import { PAGE_COOKIE, signedCookies } from "../page-access.ts";
import { noContent } from "./shared.ts";

// Long enough to keep working through an outage that began after a member opened the page; a
// removed member keeps access until then.
const ACCESS_MS = 12 * 3_600_000;

export function registerInternalPageRoutes(app: App, deps: Deps) {
  // People only: an API key has no browser to keep the cookies in.
  const member = requireRole(deps, "viewer", { apiKeys: false });

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/internal-page/access",
      tags: ["Internal page"],
      summary: "Let this browser open the internal page for 12 hours",
      description:
        "Sets CloudFront's signed cookies for /internal/ on the dashboard's origin. Signing out clears them.",
      middleware: [member],
      responses: noContent,
    }),
    async (c) => {
      const access = deps.pageAccess;
      if (!access) {
        return fail({
          status: 503,
          code: "internal_page_off",
          title: "The internal page isn't available",
          detail:
            "The API couldn't read the key that signs access to the internal page. The API's log says why; Troubleshooting in the docs says how to make a new key.",
        });
      }
      const cookies = signedCookies({
        origin: deps.publicUrl,
        expires: new Date(Date.now() + ACCESS_MS),
        ...access,
      });
      for (const [name, value] of Object.entries(cookies)) setCookie(c, name, value, PAGE_COOKIE);
      return c.body(null, 204);
    },
  );
}
