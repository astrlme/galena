"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./button.tsx";
import { Field } from "./field.tsx";

/**
 * Destructive action: an explicit verb and a dialog that asks for the name.
 * A native <dialog> traps focus and closes on Escape; it opens without motion.
 */
export function ConfirmDelete({
  kind,
  name,
  consequence,
  onConfirm,
  onClose,
}: {
  kind: "component" | "group" | "monitor";
  name: string;
  consequence: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState("");

  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-w-[480px] rounded-[8px] border border-mist bg-surface p-6 text-ink backdrop:bg-ink/40"
    >
      <h2 id={titleId} className="text-[19px] font-semibold leading-[1.35]">
        Delete {name}?
      </h2>
      <p className="mt-2 text-[16px] leading-[1.55]">{consequence}</p>
      <form
        className="mt-6 flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed === name) onConfirm();
        }}
      >
        <Field
          id={`confirm-${kind}`}
          label={`Type the ${kind} name`}
          help={`Enter “${name}” to confirm.`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
        />
        <div className="flex gap-4">
          <Button type="submit" disabled={typed !== name}>
            Delete {kind}
          </Button>
          <Button type="button" variant="quiet" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  );
}
