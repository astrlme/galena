import { z } from "zod";

// The only place in apps/api that reads process.env.
export const env = z
  .object({
    GLN_STAGE: z.enum(["local", "dev", "prod"]).default("local"),
    GLN_API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    // The origin people use: the dashboard (CloudFront in AWS, next dev locally), which also
    // serves the API on the same origin.
    GLN_PUBLIC_URL: z.url().default("http://localhost:3000"),
    // The docker-compose database; AWS stages switch to the Data API.
    GLN_DATABASE_URL: z.string().default("postgres://galena:galena@localhost:5432/galena"),
    GLN_AUTH_SECRET: z.string().min(32).optional(),
    GLN_GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GLN_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  })
  .refine((e) => e.GLN_STAGE === "local" || e.GLN_AUTH_SECRET, {
    message: "GLN_AUTH_SECRET is required outside local development (32+ characters, from SSM).",
    path: ["GLN_AUTH_SECRET"],
  })
  .parse(process.env);
