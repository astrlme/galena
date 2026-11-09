import type { Metadata } from "next";
import { Suspense } from "react";
import { Wordmark } from "../../components/wordmark.tsx";
import { InviteForm } from "./invite-form.tsx";

export const metadata: Metadata = {
  title: "Accept an invite",
  robots: { index: false, follow: false },
};

// The token comes from the query string (?token=…): a static export can't build a page per invite.
export default function Invite() {
  return (
    <main className="mx-auto flex max-w-[400px] flex-col gap-8 px-4 py-12">
      <Wordmark />
      <Suspense fallback={<p className="text-slate">Loading the invite</p>}>
        <InviteForm />
      </Suspense>
    </main>
  );
}
