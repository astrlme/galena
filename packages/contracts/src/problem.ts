import { z } from "zod";

export const problemContentType = "application/problem+json";

/** RFC 9457 problem details plus our stable, machine-readable `code`. */
export const problemDetails = z.object({
  type: z.string().min(1), // a URI reference; "about:blank" when the code says enough
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().regex(/^[a-z]+(?:_[a-z]+)*$/, "codes are snake_case"),
});
export type ProblemDetails = z.infer<typeof problemDetails>;
