import { Logger } from "@aws-lambda-powertools/logger";

type Fields = Record<string, unknown>;
export type Log = {
  info: (message: string, fields?: Fields) => void;
  error: (message: string, fields?: Fields) => void;
};

const powertools = new Logger({ serviceName: "workers" });

/** Job logs, as JSON lines on stdout: locally and on Lambda alike. */
export const log: Log = {
  info: (message, fields = {}) => powertools.info(message, fields),
  error: (message, fields = {}) => powertools.error(message, fields),
};

/**
 * An error for a log line: its name and, for a database error, the driver's code. Never the
 * message, which can carry a query's parameters or an address.
 */
export function errorFields(error: unknown): Fields {
  if (!(error instanceof Error)) return { error: typeof error };
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return { error: error.name, ...(typeof code === "string" ? { code } : {}) };
}
