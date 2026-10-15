// Packages the HTML builder Lambda into a folder: the bundled handler as index.mjs, and a
// production install of the status app for Lambda (linux, arm64, glibc) in status/. The jobs
// stack runs it when it synthesises: `node scripts/package-builder.ts <outDir>`.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: node scripts/package-builder.ts <outDir>");
const root = fileURLToPath(new URL("..", import.meta.url));

const deploy = [
  "--filter",
  "@galena/status",
  "deploy",
  "--legacy",
  "--prod",
  "--ignore-scripts",
  "--os=linux",
  "--cpu=arm64",
  "--libc=glibc",
  "--config.node-linker=hoisted",
  join(outDir, "status"),
];
// `pnpm deploy` records its install settings (production, hoisted) as the repository's own,
// after which every pnpm command here wants to reinstall it; put the repository's back.
const state = join(root, "node_modules", ".pnpm-workspace-state-v1.json");
const saved = existsSync(state) ? readFileSync(state) : undefined;
try {
  // One command line through the shell, which also runs pnpm's .cmd shim on Windows.
  execSync(["pnpm", ...deploy].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
} finally {
  if (saved) writeFileSync(state, saved);
}

// Lambda runs glibc, but pnpm installs the musl build of each native package too; and nothing
// calls a binary from .bin.
const modules = join(outDir, "status", "node_modules");
rmSync(join(modules, ".bin"), { recursive: true, force: true });
for (const name of readdirSync(modules)) {
  const dirs = name.startsWith("@")
    ? readdirSync(join(modules, name)).map((n) => join(name, n))
    : [name];
  for (const dir of dirs) if (dir.includes("musl")) rmSync(join(modules, dir), { recursive: true });
}

// The same options as the other functions' bundles (infra/stacks/bundling.ts); the Node.js
// runtime provides the AWS SDK.
buildSync({
  entryPoints: [join(root, "apps/workers/src/builder.ts")],
  outfile: join(outDir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  sourcemap: true,
  mainFields: ["module", "main"],
  external: ["@aws-sdk/*"],
  banner: {
    js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
