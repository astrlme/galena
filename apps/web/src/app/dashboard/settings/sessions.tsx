"use client";

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { authGet, authPost } from "../../../lib/api.ts";
import { Time } from "../incidents/incident-ui.tsx";
import { describeAgent } from "./describe-agent.ts";

/**
 * Refetches the session and the session list. Turning two-factor on or off and changing the
 * password each replace this browser's session, so both change together.
 */
export const refreshSessions = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    predicate: (q) => ["session", "sessions"].includes(String(q.queryKey[0])),
  });

/** One of Better Auth's `list-sessions` rows; the token is what `revoke-session` takes. */
type Session = { id: string; token: string; userAgent?: string | null; createdAt: string };

const card = "mt-4 rounded-xl border border-mist bg-surface";
const heading = "text-[19px] font-semibold leading-[1.35]";
const row =
  "flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0";

/** Where you're signed in, this browser first; any other can be signed out from here. */
export function Sessions({ currentId }: { currentId: string }) {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => authGet<Session[]>("list-sessions"),
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<string>();
  // The button pressed is gone once the list refetches, so focus moves to the heading.
  const signOut = useMutation({
    mutationFn: ({ call }: { call: () => Promise<unknown>; done: string }) => call(),
    onSuccess: (_, { done }) => {
      setNotice(done);
      headingRef.current?.focus();
    },
    onError: () => setNotice("Couldn't sign out that session. Try again."),
    onSettled: () => refreshSessions(queryClient),
  });

  const list = [...(sessions.data ?? [])].sort(
    (a, b) =>
      Number(b.id === currentId) - Number(a.id === currentId) ||
      b.createdAt.localeCompare(a.createdAt),
  );
  const others = list.filter((s) => s.id !== currentId);

  return (
    <section className="mt-8" aria-labelledby="sessions-heading">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="sessions-heading" ref={headingRef} tabIndex={-1} className={heading}>
          Where you're signed in
        </h2>
        {others.length > 0 && (
          <Button
            disabled={signOut.isPending}
            onClick={() =>
              signOut.mutate({
                call: () => authPost("revoke-other-sessions", {}),
                done: "Signed out everywhere else.",
              })
            }
          >
            Sign out everywhere else
          </Button>
        )}
      </div>
      <p role="status" className="mt-2 text-[14px] empty:hidden">
        {notice}
      </p>
      {sessions.isPending ? (
        <p className="mt-4 text-slate">Loading sessions</p>
      ) : sessions.error ? (
        <p className="mt-4 font-semibold">
          Couldn't load where you're signed in. Reload the page to try again.
        </p>
      ) : (
        <ul className={card}>
          {list.map((s) => (
            <li key={s.id} className={row}>
              <span className="flex-1 font-semibold">{describeAgent(s.userAgent)}</span>
              <span className="text-[14px] text-slate">
                Signed in <Time iso={s.createdAt} />
              </span>
              {s.id === currentId ? (
                <span className="text-[14px]">This browser</span>
              ) : (
                <Button
                  className="px-2 py-1 text-[14px]"
                  disabled={signOut.isPending}
                  onClick={() =>
                    signOut.mutate({
                      call: () => authPost("revoke-session", { token: s.token }),
                      done: `Signed out of ${describeAgent(s.userAgent)}.`,
                    })
                  }
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
