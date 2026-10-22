// Writes the `@astrlme/galena` npm package to dist/npm: apps/cli/launch.mjs as its command, and
// the source of a git ref (HEAD by default, a release tag when publishing) as plain files under
// snapshot/, which npm unpacks itself. Then `npm pack ./dist/npm` or, by the maintainer,
// `npm publish ./dist/npm --access public`: `node scripts/pack-cli.ts [ref]`.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ref = process.argv[2] ?? "HEAD";
if (!/^\w[\w./-]*$/.test(ref)) {
  throw new Error(
    `${ref} isn't a git ref. Pass a release tag such as v0.2.0, or nothing for HEAD.`,
  );
}
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "dist", "npm");
const snapshot = join(out, "snapshot");

rmSync(out, { recursive: true, force: true });
mkdirSync(snapshot, { recursive: true });
// Committed files only, so a local edit or an untracked config never ships. Without the
// .gitignore files, which npm would drop anyway while applying their rules to the files beside
// them. No shell and no path for tar: GNU tar reads `C:` in one as a remote host.
const gitignores = ":(exclude,glob)**/.gitignore";
const archive = execFileSync("git", ["archive", "--format=tar", ref, "--", ".", gitignores], {
  cwd: root,
  maxBuffer: 256 * 1024 * 1024,
});
execFileSync("tar", ["-x"], { cwd: snapshot, input: archive });

const source = JSON.parse(readFileSync(join(snapshot, "package.json"), "utf8"));
copyFileSync(join(snapshot, "apps", "cli", "launch.mjs"), join(out, "launch.mjs"));
copyFileSync(join(snapshot, "README.md"), join(out, "README.md"));
const manifest = {
  name: "@astrlme/galena",
  version: source.version,
  description: "Deploy Galena, an open-source status page, into your own AWS account.",
  license: source.license,
  homepage: "https://galena.astrl.me/docs/getting-started/self-hosting/",
  repository: { type: "git", url: "git+https://github.com/astrlme/galena.git" },
  type: "module",
  bin: { galena: "launch.mjs" },
  engines: source.engines,
  files: ["launch.mjs", "snapshot"],
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.name}@${manifest.version} from ${ref} to ${out}`);
