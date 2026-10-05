"use client";

import { type FormEvent, useState } from "react";
import { Button } from "../../components/button.tsx";
import { Field } from "../../components/field.tsx";
import { authFailure, authPost } from "../../lib/api.ts";

type Step = "password" | "code" | "backup";

const FAILED = {
  password: "Couldn't sign you in. Check the email and password, then try again.",
  code: "That code didn't match. Enter the current 6-digit code from your authenticator app.",
  backup:
    "That backup code didn't work. Each code works once; check it, or use your authenticator app.",
};

export function SignInForm() {
  const [step, setStep] = useState<Step>("password");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      if (step === "password") {
        const result = await authPost<{ twoFactorRedirect?: boolean }>("sign-in/email", {
          email: form.get("email"),
          password: form.get("password"),
        });
        if (result.twoFactorRedirect) {
          setStep("code");
          return;
        }
      } else if (step === "code") {
        await authPost("two-factor/verify-totp", { code: form.get("code") });
      } else {
        await authPost("two-factor/verify-backup-code", { code: form.get("backup") });
      }
      window.location.assign("/dashboard/");
    } catch (failure) {
      setError(authFailure(failure, FAILED[step]));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      {step === "password" ? (
        <>
          <Field id="email" label="Email" type="email" autoComplete="email" required />
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            required
          />
        </>
      ) : step === "code" ? (
        <Field
          key="code"
          id="code"
          label="Authentication code"
          help="The 6-digit code from your authenticator app."
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
        />
      ) : (
        <Field
          key="backup"
          id="backup"
          label="Backup code"
          help="One of the codes you saved when you turned on two-factor. Each works once."
          autoComplete="off"
          spellCheck={false}
          required
        />
      )}
      <p aria-live="polite" className="text-[14px] font-semibold empty:hidden">
        {error}
      </p>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Signing in…" : step === "password" ? "Sign in" : "Verify code"}
      </Button>
      {step !== "password" && (
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            setError(undefined);
            setStep(step === "code" ? "backup" : "code");
          }}
        >
          {step === "code" ? "Use a backup code instead" : "Use your authenticator app instead"}
        </Button>
      )}
    </form>
  );
}
