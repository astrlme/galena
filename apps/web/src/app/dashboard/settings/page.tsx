import type { Metadata } from "next";
import { SettingsEditor } from "./settings-editor.tsx";

export const metadata: Metadata = { title: "Settings" };

export default function Settings() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Settings</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Your own account: how you sign in, your password and where you're signed in. Admins also
        connect Slack here.
      </p>
      <SettingsEditor />
    </>
  );
}
