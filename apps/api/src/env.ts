import { z } from "zod";

// The only place in apps/api that reads process.env.
export const env = z
  .object({
    GLN_API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  })
  .parse(process.env);
