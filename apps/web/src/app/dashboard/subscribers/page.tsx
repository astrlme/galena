import type { Metadata } from "next";
import { SubscribersEditor } from "./subscribers-editor.tsx";

export const metadata: Metadata = { title: "Subscribers" };

export default function Subscribers() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Subscribers</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Who hears about published incidents and maintenance. People subscribe by email on the status
        page and confirm from their inbox; Slack channels and webhooks are added here.
      </p>
      <SubscribersEditor />
    </>
  );
}
