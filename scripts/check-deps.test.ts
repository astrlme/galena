import { cruise } from "dependency-cruiser";
import { expect, test } from "vitest";
import config from "../.dependency-cruiser.cjs";

const FIXTURES = "test/fixtures/deps/";
const short = (path: string) => path.replace(FIXTURES, "");

test("each boundary rule fires on its fixture and nowhere else", { timeout: 30_000 }, async () => {
  const { output } = await cruise([FIXTURES], {
    ...config.options,
    validate: true,
    ruleSet: { forbidden: config.forbidden },
  });
  const result = typeof output === "string" ? JSON.parse(output) : output;
  const violations = result.summary.violations
    .map((v: { rule: { name: string }; from: string; to: string }) =>
      [v.rule.name, short(v.from), short(v.to)].join("  "),
    )
    .sort();

  expect(violations).toEqual(
    [
      "contracts-no-workspace  packages/contracts/src/bad.ts  packages/db/src/index.ts",
      "contracts-only-zod  packages/contracts/src/bad.ts  fs",
      "core-is-pure  packages/core/src/bad.ts  packages/db/src/index.ts",
      "core-no-node-builtins  packages/core/src/bad.ts  fs",
      "emails-no-core  packages/emails/src/incident.ts  packages/core/src/index.ts",
      "hot-path-integrations-net-only  apps/probe/src/handler.ts  packages/integrations/src/render/slack.ts",
      "hot-path-isolated  apps/probe/src/handler.ts  node_modules/pg/index.js",
      "hot-path-isolated  apps/probe/src/handler.ts  packages/db/src/index.ts",
      "no-app-to-app  apps/web/src/page.ts  apps/status/src/page.ts",
      "no-circular  packages/core/src/cycle-a.ts  packages/core/src/cycle-b.ts",
      "not-to-unresolvable  apps/web/src/page.ts  ./missing.ts",
      "package-arrows  packages/db/src/bad.ts  packages/integrations/src/net/ssrf.ts",
      "packages-no-apps  packages/publisher/src/snapshot.ts  apps/evaluator/src/handler.ts",
      "probe-no-trigger-dev  apps/probe/src/handler.ts  node_modules/@trigger.dev/sdk/dist/index.js",
      "status-page-publisher-types-only  apps/status/src/page.ts  packages/publisher/src/snapshot.ts",
      "status-page-static  apps/status/src/page.ts  packages/core/src/index.ts",
      "ui-nothing-domain  packages/ui/src/button.ts  packages/contracts/src/index.ts",
      "ui-tokens-only  packages/integrations/src/render/slack.ts  packages/ui/src/button.ts",
    ].sort(),
  );
});
