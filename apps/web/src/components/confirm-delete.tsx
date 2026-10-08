"use client";

import { useEffect, useState } from "react";
import { Button } from "./button.tsx";
import { Field } from "./field.tsx";
import { Modal } from "./modal.tsx";

/** How long the modal takes to close before the caller unmounts it. */
const CLOSE_MS = 220;

/**
 * Destructive action: an explicit verb and a dialog that asks for the name. A centred dialog,
 * or a bottom drawer on phones; Escape, the scrim and Cancel close it.
 */
export function ConfirmDelete({
  kind,
  name,
  noun,
  consequence,
  verb = "Delete",
  onConfirm,
  onClose,
}: {
  kind: "component" | "group" | "monitor" | "window" | "destination" | "subscriber" | "Slack";
  name: string;
  /** What to type, when it isn't "the {kind} name". */
  noun?: string;
  consequence: string;
  /** The action's own word, kept from the button that opened the dialog. */
  verb?: "Delete" | "Cancel" | "Disconnect";
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [typed, setTyped] = useState("");
  // The caller unmounts this once the closing animation has run.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(onClose, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open, onClose]);

  return (
    <Modal.Root kind="dialog" open={open} onClose={() => setOpen(false)}>
      <Modal.Title>
        {verb} {name}?
      </Modal.Title>
      <Modal.Description>{consequence}</Modal.Description>
      <form
        className="mt-6 flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed === name) onConfirm();
        }}
      >
        <Field
          id={`confirm-${kind}`}
          label={`Type the ${noun ?? `${kind} name`}`}
          help={`Enter “${name}” to confirm.`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
        />
        <div className="flex gap-4">
          <Button type="submit" variant="danger" disabled={typed !== name}>
            {verb} {kind}
          </Button>
          <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
            {verb === "Cancel" ? `Keep the ${kind}` : "Cancel"}
          </Button>
        </div>
      </form>
    </Modal.Root>
  );
}
