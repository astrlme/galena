import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The repository root, where `pnpm --filter` finds every workspace package. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const quote = (arg: string) => {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return process.platform === "win32" ? `"${arg}"` : `'${arg.replaceAll("'", `'\\''`)}'`;
};

/**
 * Runs pnpm in the repository with this terminal's input and output. It goes through the shell,
 * which starts pnpm's Windows shim, so arguments are quoted; secrets only ever travel in `env`.
 */
export function pnpm(args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(["pnpm", ...args].map(quote).join(" "), {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pnpm ${args.join(" ")} stopped with exit code ${code}.`)),
    );
  });
}
