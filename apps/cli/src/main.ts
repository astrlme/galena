#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { init } from "./init.ts";

const HELP = `Usage: galena <command> [options]

Commands:
  init     Write galena.config.json for a new deployment

Options:
  --config <path>  The deployment's config file (default: galena.config.json)
  --force          init: replace an existing config file
`;

const { positionals, values } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        config: { type: "string", default: "galena.config.json" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exit(2);
  }
})();

const path = resolve(values.config);
switch (values.help ? "help" : positionals[0]) {
  case "init":
    process.exitCode = await init(path, { force: values.force });
    break;
  case "help":
    console.log(HELP);
    break;
  default:
    console.error(HELP);
    process.exitCode = 2;
}
