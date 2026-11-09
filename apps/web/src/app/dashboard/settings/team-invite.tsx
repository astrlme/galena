"use client";

import { inviteCreate, type MemberRole } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { useDraft } from "../../../components/drafts.tsx";
import { Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { FormSelect } from "../../../components/ui/select.tsx";
import { toast } from "../../../components/ui/toast.tsx";
import { UtcClock } from "../../../components/ui/utc-clock.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { roleOptions } from "./roles.ts";

// Inviting someone: their address and role in the side sheet, then the link, shown once, in a
// dialog that says whether it was emailed or is theirs to send.

type Made = { email: string; link: string; emailed: boolean; expiresAt: string };
type FormIn = z.input<typeof inviteCreate>;
type FormOut = z.output<typeof inviteCreate>;

export function InviteSheet({
  open,
  roles,
  onClose,
}: {
  open: boolean;
  roles: MemberRole[];
  onClose: () => void;
}) {
  const [made, setMade] = useState<Made>();
  const [problem, setProblem] = useState<string>();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(inviteCreate),
    defaultValues: { email: "", role: "viewer" },
  });
  const { errors, isSubmitting } = form.formState;
  const draft = useDraft("invite:new", "Invite someone", form);
  const close = () => {
    setMade(undefined);
    setProblem(undefined);
    onClose();
  };
  const submit = form.handleSubmit(async (values) => {
    setProblem(undefined);
    try {
      const created = await unwrap(api.POST("/v1/invites", { body: values }));
      setMade(created);
      draft.discard();
      form.reset({ email: "", role: "viewer" });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't invite them. Try again.");
    }
  });

  return (
    <>
      <Modal.Root open={open && !made} onClose={close}>
        <Modal.Title>Invite someone</Modal.Title>
        <form
          onSubmit={submit}
          aria-label="Invite someone"
          className="mt-6 flex flex-col gap-4"
          noValidate
        >
          <Field
            id="invite-email"
            label="Email"
            type="email"
            autoComplete="off"
            help="Only an account with this address can accept."
            error={errors.email?.message}
            {...form.register("email")}
          />
          <FormSelect
            control={form.control}
            name="role"
            label="Role"
            options={roleOptions(roles)}
          />
          <p aria-live="polite" className="font-semibold text-major empty:hidden">
            {problem}
          </p>
          <div className="flex gap-4">
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? "Inviting…" : "Invite"}
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                draft.discard();
                close();
              }}
            >
              {draft.dirty ? "Discard" : "Cancel"}
            </Button>
          </div>
        </form>
      </Modal.Root>
      <Modal.Root
        kind="dialog"
        open={made !== undefined}
        onClose={close}
        // The link isn't shown again: inviting the address again makes a new one. Done closes it.
        closeOnOverlayClick={false}
        closeOnEsc={false}
      >
        {made && (
          <>
            <Modal.Title>Invite for {made.email}</Modal.Title>
            <div role="status" className="mt-4 flex flex-col gap-2">
              <p className="break-all rounded-[6px] border border-mist bg-paper p-3 font-mono text-[14px]">
                {made.link}
              </p>
              <p className="text-[14px] text-slate">
                {made.emailed
                  ? `We emailed it to ${made.email}. `
                  : `This deployment sends no email: send it to ${made.email} yourself. `}
                It works once, for that address, until <UtcClock iso={made.expiresAt} />.
              </p>
            </div>
            <div className="mt-6 flex gap-4">
              <Button
                variant="primary"
                onClick={() =>
                  navigator.clipboard.writeText(made.link).then(
                    () => toast("Invite link copied"),
                    () => toast("Couldn't copy the link. Select it and copy it yourself."),
                  )
                }
              >
                Copy link
              </Button>
              <Button onClick={close}>Done</Button>
            </div>
          </>
        )}
      </Modal.Root>
    </>
  );
}
