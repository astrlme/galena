"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { authPost } from "../../../lib/api.ts";
import { refreshSessions } from "./sessions.tsx";

// The API's minimum (Better Auth's `minPasswordLength`).
const MIN_LENGTH = 12;

const card = "mt-4 rounded-xl border border-mist bg-surface p-4";
const heading = "text-[19px] font-semibold leading-[1.35]";

/** Changing the password signs out every other session; this one gets a fresh token. */
export function Password() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});
  const [pending, setPending] = useState(false);
  const [changed, setChanged] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get("new-password") ?? "");
    if (next.length < MIN_LENGTH) {
      setErrors({ next: `Use at least ${MIN_LENGTH} characters.` });
      return;
    }
    setPending(true);
    setErrors({});
    try {
      await authPost("change-password", {
        currentPassword: form.get("current-password"),
        newPassword: next,
        revokeOtherSessions: true,
      });
      setOpen(false);
      setChanged(true);
      await refreshSessions(queryClient);
    } catch {
      setErrors({
        current: "That password didn't match. Enter the password you sign in with now.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={card} aria-labelledby="password-heading">
      <h2 id="password-heading" className={heading}>
        Password
      </h2>
      <p role="status" className="mt-1 max-w-[72ch] text-[16px] text-slate">
        {changed
          ? "Password changed. Your other sessions are signed out."
          : "Changing it signs you out everywhere else."}
      </p>
      <div className="mt-4">
        <Button
          onClick={() => {
            setErrors({});
            setChanged(false);
            setOpen(true);
          }}
        >
          Change password
        </Button>
      </div>
      <Modal.Root kind="dialog" open={open} onClose={() => setOpen(false)}>
        <Modal.Title>Change password</Modal.Title>
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
          <Field
            id="current-password"
            label="Current password"
            type="password"
            autoComplete="current-password"
            error={errors.current}
            required
          />
          <Field
            id="new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            help={`At least ${MIN_LENGTH} characters.`}
            error={errors.next}
            required
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Changing…" : "Change password"}
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal.Root>
    </section>
  );
}
