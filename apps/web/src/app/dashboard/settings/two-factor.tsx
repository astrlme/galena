"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { QrCode } from "../../../components/qr-code.tsx";
import { authPost } from "../../../lib/api.ts";
import { refreshSessions } from "./sessions.tsx";

// Turning two-factor on is three steps in one dialog: the password, the authenticator app (a QR
// code and its key), then the backup codes, shown once. Nothing typed here is kept as a draft.

type Flow = "enable" | "codes" | "disable";
type Step =
  | { name: "password" }
  | { name: "app"; uri: string; codes: string[] }
  | { name: "codes"; codes: string[] };

const WRONG_PASSWORD = "That password didn't match. Enter the password you sign in with.";
const WRONG_CODE =
  "That code didn't match. Enter the current 6-digit code from your authenticator app.";

const card = "mt-4 rounded-xl border border-mist bg-surface p-4";
const heading = "text-[19px] font-semibold leading-[1.35]";

/** The base32 key inside an otpauth:// URI, in groups of four for typing by hand. */
const keyOf = (uri: string) =>
  (new URL(uri).searchParams.get("secret") ?? "").match(/.{1,4}/g)?.join(" ") ?? "";

export function TwoFactor({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<Flow>();
  const [step, setStep] = useState<Step>({ name: "password" });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const open = (next: Flow) => {
    setStep({ name: "password" });
    setError(undefined);
    setFlow(next);
  };
  const close = () => {
    setFlow(undefined);
    return refreshSessions(queryClient);
  };

  /** Runs one step's request; a failure shows `failed` and keeps the dialog on that step. */
  async function attempt(
    event: FormEvent<HTMLFormElement>,
    failed: string,
    run: (form: FormData) => Promise<void>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      await run(form);
    } catch {
      setError(failed);
    } finally {
      setPending(false);
    }
  }

  const password = (event: FormEvent<HTMLFormElement>) =>
    attempt(event, WRONG_PASSWORD, async (form) => {
      const body = { password: form.get("password") };
      if (flow === "enable") {
        const started = await authPost<{ totpURI: string; backupCodes: string[] }>(
          "two-factor/enable",
          { ...body, method: "totp" },
        );
        setStep({ name: "app", uri: started.totpURI, codes: started.backupCodes });
      } else if (flow === "codes") {
        const { backupCodes } = await authPost<{ backupCodes: string[] }>(
          "two-factor/generate-backup-codes",
          body,
        );
        setStep({ name: "codes", codes: backupCodes });
      } else {
        await authPost("two-factor/disable", body);
        await close();
      }
    });

  const verify = (event: FormEvent<HTMLFormElement>, codes: string[]) =>
    attempt(event, WRONG_CODE, async (form) => {
      await authPost("two-factor/verify-totp", { code: form.get("code") });
      setStep({ name: "codes", codes });
    });

  const title = {
    enable: "Turn on two-factor",
    codes: "New backup codes",
    disable: "Turn off two-factor",
  };
  const passwordHelp = {
    enable: "Confirm it's you before adding an authenticator app.",
    codes: "The codes you have now stop working once new ones are made.",
    disable: "Sign-in will ask only for your password afterwards.",
  };

  return (
    <section className={card} aria-labelledby="two-factor-heading">
      <h2 id="two-factor-heading" className={heading}>
        Two-factor sign-in
      </h2>
      <p className="mt-1 max-w-[72ch] text-[16px] text-slate">
        {enabled
          ? "On. Sign-in asks for a code from your authenticator app, or one of your backup codes."
          : "Off. Sign-in asks only for your password. Turn it on to also ask for a code from an authenticator app."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {enabled ? (
          <>
            <Button onClick={() => open("codes")}>New backup codes</Button>
            <Button onClick={() => open("disable")}>Turn off two-factor</Button>
          </>
        ) : (
          <Button onClick={() => open("enable")}>Turn on two-factor</Button>
        )}
      </div>

      <Modal.Root
        kind="dialog"
        open={flow !== undefined}
        onClose={close}
        // Backup codes aren't shown again, so that step closes only on Done.
        closeOnOverlayClick={step.name !== "codes"}
        closeOnEsc={step.name !== "codes"}
      >
        {flow && <Modal.Title>{title[flow]}</Modal.Title>}
        {flow && step.name === "password" && (
          <form onSubmit={password} className="mt-4 flex flex-col gap-4" noValidate>
            <Field
              id="password"
              label="Your password"
              type="password"
              autoComplete="current-password"
              help={passwordHelp[flow]}
              error={error}
              required
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Checking…" : flow === "disable" ? "Turn off two-factor" : "Continue"}
              </Button>
              <Button type="button" onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {step.name === "app" && (
          <form
            onSubmit={(event) => verify(event, step.codes)}
            className="mt-4 flex flex-col gap-4"
            noValidate
          >
            <p className="text-[16px]">
              Scan this code with your authenticator app, or enter the key by hand.
            </p>
            <QrCode value={step.uri} label="QR code for your authenticator app" />
            <div className="flex flex-col gap-1">
              <p className="text-[14px] font-semibold">Key</p>
              <p className="break-all font-mono text-[14px]" data-testid="totp-key">
                {keyOf(step.uri)}
              </p>
            </div>
            <Field
              id="code"
              label="Code from the app"
              help="Two-factor turns on once this code matches."
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              error={error}
              required
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Checking…" : "Turn on two-factor"}
              </Button>
              <Button type="button" onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {step.name === "codes" && <BackupCodes codes={step.codes} onDone={close} />}
      </Modal.Root>
    </section>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="mt-4 flex flex-col gap-4">
      <p className="text-[16px]">
        Keep these somewhere safe. If you lose your authenticator app, each one signs you in once.
        They aren't shown again.
      </p>
      <ul
        aria-label="Backup codes"
        className="grid grid-cols-2 gap-2 rounded-[6px] border border-mist bg-paper p-3 font-mono text-[14px]"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy codes"}
        </Button>
      </div>
    </div>
  );
}
