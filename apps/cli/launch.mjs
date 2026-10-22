#!/usr/bin/env node
// The `@astrlme/galena` package's command. The package carries this version's source; it is
// copied to ~/.galena/<version> and installed there once, then its CLI runs with the caller's
// directory and arguments. Node won't strip TypeScript under node_modules, so the source can't
// run from npm's cache. No dependencies: nothing is installed when this starts.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const home = join(homedir(), ".galena");
const root = join(home, version);
const bin = join(home, "bin");
// The CLI starts `pnpm` itself, so corepack's shim goes first on the PATH.
const env = {
  ...process.env,
  PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  // How the CLI tells people to run it again.
  GALENA_COMMAND: `npx @astrlme/galena@${version}`,
};

// As in apps/cli/src/run.ts, which can't be imported before anything is installed: one quoted
// shell line, which starts the Windows shims too.
const quote = (arg) => {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return process.platform === "win32" ? `"${arg}"` : `'${arg.replaceAll("'", `'\\''`)}'`;
};
const runShell = (args) =>
  spawnSync(args.map(quote).join(" "), { cwd: root, env, stdio: "inherit", shell: true }).status;

// Written only once the install succeeded, so an interrupted one starts again.
const marker = join(root, ".installed");
if (!existsSync(marker)) {
  console.error(`Installing Galena ${version} in ${root}, once for this version.`);
  mkdirSync(bin, { recursive: true });
  cpSync(join(here, "snapshot"), root, { recursive: true, force: true });
  // corepack picks the pnpm version the source's `packageManager` names.
  if (
    runShell(["corepack", "enable", "--install-directory", bin, "pnpm"]) !== 0 ||
    runShell(["pnpm", "install", "--frozen-lockfile"]) !== 0
  ) {
    console.error(
      "Couldn't install Galena's dependencies. Node 24 includes corepack; on a newer Node, run npm install --global corepack. Then run the same command again.",
    );
    process.exit(1);
  }
  writeFileSync(marker, `${version}\n`);
}

const cli = join(root, "apps", "cli", "src", "main.ts");
const { status, signal, error } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
if (error) throw error;
// Stopped by a signal (Ctrl+C), the launcher stops the same way.
if (signal) process.kill(process.pid, signal);
process.exitCode = status ?? 1;
