import { z } from "zod";
import { eventId, workspaceId } from "./ids.ts";

/** Parser for one event type's envelope. */
export function eventEnvelope<TType extends string, TData extends z.ZodType>(
  type: TType,
  data: TData,
) {
  return z.object({
    id: eventId,
    type: z.literal(type),
    occurredAt: z.iso.datetime(), // ISO 8601 in UTC: a trailing Z, never an offset
    workspaceId,
    data,
  });
}

export type EventEnvelope<TType extends string, TData> = {
  id: z.infer<typeof eventId>;
  type: TType;
  occurredAt: string;
  workspaceId: z.infer<typeof workspaceId>;
  data: TData;
};
