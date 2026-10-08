"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, buttonClass } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { Time } from "../incidents/incident-ui.tsx";

const card = "mt-4 flex flex-col items-start gap-4 rounded-xl border border-mist bg-surface p-4";
const heading = "text-[19px] font-semibold leading-[1.35]";

// What the install came back with: Slack's consent screen returns here with `?slack=…`.
const results: Record<string, string> = {
  connected: "Slack connected.",
  cancelled: "Slack wasn't connected: the install was cancelled in Slack.",
  failed:
    "Couldn't connect Slack. Try again; if it keeps failing, check the Slack app's secrets in /galena/<name>/slack-app.",
};

/** Admins connect the Slack app here; for everyone else the section isn't shown. */
export function SlackConnection() {
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const slack = useQuery({
    queryKey: ["slack"],
    queryFn: async () => {
      const { data, response } = await api.GET("/v1/slack");
      // Only admins manage Slack.
      if (response.status === 403) return null;
      if (!data)
        throw new Error("Couldn't load the Slack connection. Reload the page to try again.");
      return data;
    },
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/slack")),
    onSuccess: () => {
      setNotice("Slack disconnected.");
      headingRef.current?.focus();
    },
    onError: (error) => setNotice(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["slack"] }),
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("slack");
    if (!result) return;
    setNotice(results[result]);
    url.searchParams.delete("slack");
    window.history.replaceState(null, "", url);
  }, []);

  if (slack.data === null) return null;
  const connection = slack.data?.connection;

  return (
    <section className="mt-8" aria-labelledby="slack-heading">
      <h2 id="slack-heading" ref={headingRef} tabIndex={-1} className={heading}>
        Slack
      </h2>
      <p className="mt-2 max-w-[72ch] text-slate">
        Approve or dismiss drafts from a Slack channel, and see what's open with /incident. Only
        people whose Slack email belongs to an editor or above here can decide a draft.
      </p>
      <div className={card}>
        {slack.isPending ? (
          <p className="text-slate">Loading the Slack connection</p>
        ) : slack.error ? (
          <p className="font-semibold">{slack.error.message}</p>
        ) : !slack.data.available ? (
          <p>
            Slack isn't set up for this deployment yet.{" "}
            <a href="/docs/guides/slack-app/" className="underline">
              Set up the Slack app
            </a>
          </p>
        ) : connection ? (
          <>
            <p>
              Connected to <span className="font-semibold">{connection.teamName}</span>. Approval
              cards go to {connection.channelName}.
              <span className="block text-[14px] text-slate">
                Since <Time iso={connection.connectedAt} />
              </span>
            </p>
            <Button onClick={() => setConfirming(true)} disabled={disconnect.isPending}>
              Disconnect Slack
            </Button>
          </>
        ) : (
          <>
            <p>Slack asks which channel approval cards go to.</p>
            <a href="/slack/install" className={buttonClass("primary")}>
              Connect Slack
            </a>
          </>
        )}
      </div>
      <p role="status" className="mt-3 text-[14px] font-semibold empty:hidden">
        {notice}
      </p>
      {confirming && connection && (
        <ConfirmDelete
          kind="Slack"
          verb="Disconnect"
          name={connection.teamName}
          noun="Slack workspace name"
          consequence={`Approval cards stop going to ${connection.channelName}, and Slack's buttons and /incident stop working until someone connects it again.`}
          onConfirm={() => {
            disconnect.mutate();
            setConfirming(false);
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
