import { fileURLToPath } from "node:url";
import { OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";

/** A path in the repository, for `NodejsFunction` entries. */
export const source = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export const bundling = {
  format: OutputFormat.ESM,
  target: "node24",
  minify: true,
  sourceMap: true,
  mainFields: ["module", "main"],
  // Some dependencies still call require() inside an ES module bundle.
  banner:
    "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
};
