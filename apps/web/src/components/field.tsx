import type { InputHTMLAttributes } from "react";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
};

/** Inputs, selects and textareas: a hairline that darkens on hover and focus, red when invalid. */
export const control =
  "rounded-[6px] border border-mist bg-paper px-3 py-2 text-[16px] text-ink transition-colors duration-[120ms] hover:border-slate focus:border-ink motion-reduce:transition-none aria-invalid:border-major";

/** Label above, help or error below. */
export function Field({ id, label, help, error, ...input }: FieldProps) {
  const note = error ?? help;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[14px] font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        className={control}
        {...input}
      />
      {note && (
        <p
          id={`${id}-note`}
          className={`text-[14px] ${error ? "font-semibold text-major" : "text-slate"}`}
        >
          {note}
        </p>
      )}
    </div>
  );
}
