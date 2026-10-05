// `GLN_MEMBER_EMAIL=… pnpm --filter @galena/api member:local`: a viewer on the seeded workspace,
// for end-to-end tests that change their own account (two-factor, password) and so must not use
// the seeded owner. Sign-up is closed once a workspace exists, so the rows are written directly.
// Prints the email.
import { memberId, workspaceId } from "@galena/contracts";
import { createDb, schema } from "@galena/db";
import { hashPassword } from "better-auth/crypto";
import { v7 } from "uuid";
import { env } from "./env.ts";

if (env.GLN_STAGE !== "local" || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.GLN_DATABASE_URL)) {
  throw new Error("member:local only runs against the local docker-compose database.");
}

/** The password every local member signs in with. */
const LOCAL_MEMBER_PASSWORD = "galena-local-member";

const acme = workspaceId.parse("01920000-0000-7000-8000-000000000001");
const email = (process.env.GLN_MEMBER_EMAIL ?? `member-${Date.now()}@example.com`).toLowerCase();

const { db, close } = createDb({ kind: "postgres", url: env.GLN_DATABASE_URL });
try {
  const userId = v7();
  await db.transaction(async (tx) => {
    await tx.insert(schema.user).values({ id: userId, name: "Local member", email });
    await tx.insert(schema.account).values({
      id: v7(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(LOCAL_MEMBER_PASSWORD),
    });
    await tx
      .insert(schema.member)
      .values({ id: memberId.parse(v7()), workspaceId: acme, userId, role: "viewer" });
  });
  console.log(email);
} finally {
  await close();
}
