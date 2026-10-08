"use client";

import { useQuery } from "@tanstack/react-query";
import { authGet } from "../../../lib/api.ts";
import { Password } from "./password.tsx";
import { Sessions } from "./sessions.tsx";
import { SlackConnection } from "./slack.tsx";
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
  if (current.error) {
    return (
      <p className="mt-8 font-semibold">
        Couldn't load your account. Reload the page to try again.
      </p>
    );
  }
  if (!current.data) {
    return (
      <p className="mt-8 font-semibold">
        You're signed out.{" "}
        <a href="/sign-in/" className="underline">
          Sign in again
        </a>
      </p>
    );
  }
  return (
    <>
      <TwoFactor enabled={current.data.user.twoFactorEnabled === true} />
      <Password />
      <Sessions currentId={current.data.session.id} />
      <SlackConnection />
    </>
  );
}
