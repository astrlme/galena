import { z } from "zod";
import { apiKeyScopes } from "./enums.ts";
import { apiKeyId } from "./ids.ts";

/** An API key as an admin makes it: what it's for, and how far it reaches. */
export const apiKeyInput = z.object({
  name: z.string().trim().min(1, "Give it a name, like the script that uses it.").max(100),
  scope: z.enum(apiKeyScopes),
});
export type ApiKeyInput = z.infer<typeof apiKeyInput>;

/** Never the key itself: only its first characters, to tell keys apart. */
export const apiKeyView = z.object({
  id: apiKeyId,
  name: z.string(),
  scope: z.enum(apiKeyScopes),
  prefix: z.string(),
  createdAt: z.iso.datetime(),
});
export type ApiKeyView = z.infer<typeof apiKeyView>;

/** The key appears once, in this answer. */
export const apiKeyCreated = z.object({ apiKey: apiKeyView, key: z.string() });
