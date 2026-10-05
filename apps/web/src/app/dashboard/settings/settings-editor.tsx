"use client";

import { useQuery } from "@tanstack/react-query";
import { authGet } from "../../../lib/api.ts";
import { Password } from "./password.tsx";
import { Sessions } from "./sessions.tsx";
import { TwoFactor } from "./two-factor.tsx";

/** What Better Auth's `get-session` returns for the signed-in person. */
export type CurrentSession = {
  session: { id: string };
  user: { email: string; twoFactorEnabled?: boolean | null };
};

export function SettingsEditor() {
  const current = useQuery({
    queryKey: ["session"],
    queryFn: () => authGet<CurrentSession | null>("get-session"),
  });

  if (current.isPending) return <p className="mt-8 text-slate">Loading your account</p>;
  if (current.error || !current.data) {
    return <p className="mt-8 font-semibold">{current.error?.message ?? "You're signed out."}</p>;
  }
  return (
    <>
      <TwoFactor enabled={current.data.user.twoFactorEnabled === true} />
      <Password />
      <Sessions currentId={current.data.session.id} />
    </>
  );
}
