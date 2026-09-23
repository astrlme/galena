import { z } from "zod";
import { changeActions, componentStatuses } from "./enums.ts";
import { eventEnvelope } from "./events.ts";
import { componentGroupId, componentId } from "./ids.ts";

// Request and response shapes shared by the API and the dashboard forms.

const name = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(100, "Keep the name under 100 characters.");

export const componentInput = z.object({
  name,
  description: z.string().trim().max(500).nullable().default(null),
  groupId: componentGroupId.nullable().default(null),
});
export type ComponentInput = z.infer<typeof componentInput>;

export const componentPatch = z
  .object({
    name,
    description: z.string().trim().max(500).nullable(),
    groupId: componentGroupId.nullable(),
  })
  .partial();
export type ComponentPatch = z.infer<typeof componentPatch>;

export const componentGroupInput = z.object({ name });
export type ComponentGroupInput = z.infer<typeof componentGroupInput>;

/** The complete new order, first to last. */
export const reorderInput = z.object({ ids: z.array(z.uuid()).max(500) });

export const componentView = z.object({
  id: componentId,
  groupId: componentGroupId.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  status: z.enum(componentStatuses),
});

export const componentGroupView = z.object({
  id: componentGroupId,
  name: z.string(),
  position: z.number().int(),
});

const changeData = z.object({ action: z.enum(changeActions), ids: z.array(z.uuid()) });

/** Components were created, edited, deleted or reordered; the page needs publishing again. */
export const componentChanged = eventEnvelope("component.changed", changeData);
export const componentGroupChanged = eventEnvelope("component_group.changed", changeData);
export type ChangeData = z.infer<typeof changeData>;
