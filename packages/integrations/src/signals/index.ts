import {
  alertmanagerPayload,
  genericPayload,
  type Signal,
  type SignalSource,
} from "@galena/contracts";
import { assertNever } from "@galena/core";
import { readAlertmanager } from "./alertmanager.ts";
import { readGeneric } from "./generic.ts";

/** The alert groups in a request body, or undefined when it isn't a body that source sends. */
export function readSignals(source: SignalSource, body: unknown): Signal[] | undefined {
  switch (source) {
    case "alertmanager": {
      const parsed = alertmanagerPayload.safeParse(body);
      return parsed.success ? [readAlertmanager(parsed.data)] : undefined;
    }
    case "generic": {
      const parsed = genericPayload.safeParse(body);
      return parsed.success ? parsed.data.map(readGeneric) : undefined;
    }
    default:
      return assertNever(source);
  }
}
