// Import boundaries between the apps and packages.
// Paths match with `(?:^|/)` so the fixtures in test/fixtures/deps exercise the same rules
// (scripts/check-deps.test.ts). Change a rule and its fixture together.

const pkg = (names) => `(?:^|/)packages/(?:${names})/`;
// pnpm resolves to node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/…, so the inner
// `node_modules/<pkg>/` matches with a flat layout too.
const npm = (names) => `(?:^|/)node_modules/(?:${names})/`;
const NPM_TYPES = [
  "npm",
  "npm-dev",
  "npm-optional",
  "npm-peer",
  "npm-bundled",
  "npm-no-pkg",
  "npm-unknown",
];
const UI_TOKENS_ONLY = { path: pkg("ui"), pathNot: "(?:^|/)packages/ui/src/tokens\\.(?:ts|css)$" };
const POSTGRES = npm("pg|drizzle-orm|@aws-sdk/client-rds-data");
const TRIGGER_DEV = npm("@trigger\\.dev");
// Tests and tool config (vitest.config.ts) are not shipped, so the purity rules skip them.
const NOT_SHIPPED = String.raw`\.test\.tsx?$|(?:^|/)[\w.-]+\.config\.[cm]?[jt]s$`;

module.exports = {
  forbidden: [
    {
      name: "contracts-no-workspace",
      comment: "packages/contracts depends on no other workspace package",
      severity: "error",
      from: { path: pkg("contracts"), pathNot: NOT_SHIPPED },
      to: { path: "(?:^|/)(?:packages|apps)/", pathNot: pkg("contracts") },
    },
    {
      name: "contracts-only-zod",
      comment: "packages/contracts depends on zod and nothing else, not even Node built-ins",
      severity: "error",
      from: { path: pkg("contracts"), pathNot: NOT_SHIPPED },
      to: { dependencyTypes: [...NPM_TYPES, "core"], pathNot: npm("zod") },
    },
    {
      name: "core-is-pure",
      comment: "packages/core imports contracts only: no db, integrations, AWS SDK or Node I/O",
      severity: "error",
      from: { path: pkg("core"), pathNot: NOT_SHIPPED },
      to: {
        path: `${pkg("db|integrations|publisher|emails|ui")}|(?:^|/)apps/|${npm("@aws-sdk")}|${TRIGGER_DEV}`,
      },
    },
    {
      name: "core-no-node-builtins",
      comment: "packages/core does no I/O, so it never needs a Node built-in",
      severity: "error",
      from: { path: pkg("core"), pathNot: NOT_SHIPPED },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "hot-path-isolated",
      comment: "probe and evaluator never touch Postgres, publisher or emails",
      severity: "error",
      from: { path: "(?:^|/)apps/(?:probe|evaluator)/" },
      to: { path: `${pkg("db|publisher|emails")}|${POSTGRES}` },
    },
    {
      name: "hot-path-integrations-net-only",
      comment:
        "the hot path may use integrations/net (SSRF guard, HTTP checker) and nothing else there",
      severity: "error",
      from: { path: "(?:^|/)apps/(?:probe|evaluator)/" },
      to: { path: pkg("integrations"), pathNot: "(?:^|/)packages/integrations/src/net/" },
    },
    {
      name: "probe-no-trigger-dev",
      comment:
        "only the evaluator calls trigger.dev, and only tasks.trigger on a transition (review checks the call)",
      severity: "error",
      from: { path: "(?:^|/)apps/probe/" },
      to: { path: TRIGGER_DEV },
    },
    {
      name: "status-page-static",
      comment: "the status page reads published files only",
      severity: "error",
      from: { path: "(?:^|/)apps/status/" },
      to: { path: `${pkg("db|core|integrations|emails")}|${POSTGRES}|${TRIGGER_DEV}` },
    },
    {
      name: "status-page-publisher-types-only",
      comment: "apps/status may import publisher types, never publisher code",
      severity: "error",
      from: { path: "(?:^|/)apps/status/" },
      to: { path: pkg("publisher"), dependencyTypesNot: ["type-only"] },
    },
    {
      name: "ui-tokens-only",
      comment:
        "status page, publisher, integrations and emails take tokens from ui, not components",
      severity: "error",
      from: { path: `(?:^|/)apps/status/|${pkg("publisher|integrations|emails")}` },
      to: UI_TOKENS_ONLY,
    },
    {
      name: "package-arrows",
      comment:
        "db → core, contracts; integrations and publisher → core, contracts, ui tokens; emails → contracts, ui tokens",
      severity: "error",
      from: { path: "(?:^|/)packages/(db|integrations|publisher|emails)/" },
      to: { path: pkg("db|integrations|publisher|emails"), pathNot: "(?:^|/)packages/$1/" },
    },
    {
      name: "emails-no-core",
      comment: "emails render contracts types; domain logic stays out of templates",
      severity: "error",
      from: { path: pkg("emails") },
      to: { path: pkg("core") },
    },
    {
      name: "ui-nothing-domain",
      comment: "packages/ui holds tokens and generic components, no domain packages",
      severity: "error",
      from: { path: pkg("ui") },
      to: { path: `${pkg("contracts|core|db|integrations|publisher|emails")}|(?:^|/)apps/` },
    },
    {
      name: "packages-no-apps",
      comment: "packages never import apps",
      severity: "error",
      from: { path: "(?:^|/)packages/" },
      to: { path: "(?:^|/)apps/" },
    },
    {
      name: "no-app-to-app",
      comment: "an app may import any package but never another app",
      severity: "error",
      from: { path: "(?:^|/)apps/([^/]+)/" },
      to: { path: "(?:^|/)apps/", pathNot: "(?:^|/)apps/$1/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "an import that does not resolve is a typo or a missing dependency",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // No includeOnly: it would drop node_modules targets and blind the npm rules above.
    // Our own build output and generated files only. npm packages often resolve through dist/,
    // and excluding those would drop them from the graph and blind the npm rules too.
    exclude: {
      path: "^(?:apps|packages)/[^/]+/(?:dist|out|coverage|\\.next|\\.astro|\\.turbo)/|^infra/cdk\\.out/|^apps/web/next-env\\.d\\.ts$",
    },
    doNotFollow: { path: "(?:^|/)node_modules/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
