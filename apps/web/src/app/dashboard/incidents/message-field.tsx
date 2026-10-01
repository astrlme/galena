"use client";

import type { IncidentStatus } from "@galena/contracts";
import { fillTemplate } from "@galena/core";
import { useEffect, useRef } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import { control } from "../../../components/field.tsx";

/**
 * Starts the message from the status's template, with the affected components filled in. It
 * replaces only an empty message or the template it wrote itself, never someone's own words.
 */
export function useTemplate(
  status: IncidentStatus,
  component: string | undefined,
  body: string,
  setBody: (text: string) => void,
) {
  const current = useRef({ body, setBody });
  current.current = { body, setBody };
  const written = useRef("");
  useEffect(() => {
    const next = fillTemplate(status, component ? { component } : {});
    const { body, setBody } = current.current;
    if (body.trim() === "" || body === written.current) setBody(next);
    written.current = next;
  }, [status, component]);
}

/** The update text: Markdown, starting from the status's template. */
export function MessageField({
  id,
  error,
  registration,
}: {
  id: string;
  error: string | undefined;
  registration: UseFormRegisterReturn;
}) {
  const note = error ?? "Markdown. Replace anything in braces before you post.";
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[14px] font-semibold">
        Message
      </label>
      <textarea
        id={id}
        rows={4}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-note`}
        className={control}
        {...registration}
      />
      <p
        id={`${id}-note`}
        className={`text-[14px] ${error ? "font-semibold text-ink" : "text-slate"}`}
      >
        {note}
      </p>
    </div>
  );
}
