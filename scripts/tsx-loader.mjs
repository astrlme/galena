import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

/** Compiles .tsx with React's automatic JSX runtime; everything else loads as usual. */
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".tsx")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const { code } = await transform(source, {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
    sourcefile: url,
    sourcemap: "inline",
  });
  return { format: "module", source: code, shortCircuit: true };
}
