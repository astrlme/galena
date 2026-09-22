"use client";

import { type FormEvent, useState } from "react";
import { Button } from "../../components/button.tsx";
import { Field } from "../../components/field.tsx";
import { authPost } from "../../lib/api.ts";

type Step = "password" | "code";

const FAILED = {
  password: "Couldn't sign you in. Check the email and password, then try again.",
  code: "That code didn't match. Enter the current 6-digit code from your authenticator app.",
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
      } else {
        await authPost("two-factor/verify-totp", { code: form.get("code") });
      }
      window.location.assign("/dashboard/");
    } catch {
      setError(FAILED[step]);
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
      ) : (
        <Field
          id="code"
          label="Authentication code"
          help="The 6-digit code from your authenticator app."
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
        />
      )}
      <p aria-live="polite" className="text-[14px] font-semibold empty:hidden">
        {error}
      </p>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Signing in…" : step === "password" ? "Sign in" : "Verify code"}
      </Button>
    </form>
  );
}
