import { type Db, schema, workspaceExists } from "@galena/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";

export type AuthConfig = {
  db: Db;
  /** Signs sessions and encrypts TOTP secrets. From SSM in AWS; never in code. */
  secret: string;
  /** Where the API is reached, e.g. http://localhost:8787. */
  baseURL: string;
  /** Present once the owner has created a GitHub OAuth App; sign-in with GitHub stays off until then. */
  github?: { clientId: string; clientSecret: string };
};

export function createAuth({ db, secret, baseURL, github }: AuthConfig) {
  return betterAuth({
    appName: "Galena",
    secret,
    baseURL,
    basePath: "/auth",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    ...(github ? { socialProviders: { github } } : {}),
    plugins: [twoFactor({ issuer: "Galena" })],
    databaseHooks: {
      user: {
        create: {
          // Only the first-run setup creates an account; afterwards owners invite people.
          before: async (user) => {
            if (await workspaceExists(db)) {
              throw new APIError("FORBIDDEN", {
                message: "Sign-up is closed. Ask an owner of this workspace to invite you.",
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
