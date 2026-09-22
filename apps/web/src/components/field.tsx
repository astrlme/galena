import type { InputHTMLAttributes } from "react";

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  help?: string;
  error?: string;
};

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
        className="rounded-[4px] border border-slate bg-surface px-3 py-2 text-[16px] text-ink aria-invalid:border-2 aria-invalid:border-ink"
        {...input}
      />
      {note && (
        <p
          id={`${id}-note`}
          className={`text-[14px] ${error ? "font-semibold text-ink" : "text-slate"}`}
        >
          {note}
        </p>
      )}
    </div>
  );
}
