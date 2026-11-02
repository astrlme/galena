"use client";

import { Select as Base } from "@base-ui/react/select";
import type { ComponentStatus } from "@galena/contracts";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId } from "react";
import { type Control, type FieldValues, type Path, useController } from "react-hook-form";
import { control } from "../field.tsx";
import { StateGlyph } from "../status.tsx";
import { usePortalContainer } from "./portal.tsx";

/** A choice; a state ("Major outage") carries its status, so it shows its glyph as well. */
export type Option<V> = { value: V; label: string; status?: ComponentStatus };

type SelectProps<V> = {
  label: string;
  options: Option<V>[];
  value: V;
  onChange: (value: V) => void;
  help?: string | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
  /** Hides the label visually, for a select whose row already says what it is. */
  hideLabel?: boolean;
};

function OptionLabel<V>({ option }: { option: Option<V> }) {
  return (
    <span className="flex items-center gap-2">
      {option.status && <StateGlyph status={option.status} />}
      {option.label}
    </span>
  );
}

/**
 * A select in the input's look: label above, help or error below, a list that opens under it.
 * Options are values with labels; `null` is a value too ("No component").
 */
export function Select<V extends string | null>({
  label,
  options,
  value,
  onChange,
  help,
  error,
  disabled,
  hideLabel = false,
}: SelectProps<V>) {
  const container = usePortalContainer();
  const noteId = useId();
  const note = error ?? help;
  return (
    <Base.Root
      items={options}
      value={value}
      onValueChange={(next) => onChange(next as V)}
      disabled={disabled ?? false}
    >
      <div className="flex flex-col gap-1">
        <Base.Label className={hideLabel ? "sr-only" : "text-[14px] font-semibold"}>
          {label}
        </Base.Label>
        <Base.Trigger
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          className={`${control} flex min-h-[44px] min-w-[200px] items-center justify-between gap-3 text-left data-popup-open:border-ink data-disabled:text-slate`}
        >
          <Base.Value>
            {(current: V) => {
              const option = options.find((o) => o.value === current);
              return option ? <OptionLabel option={option} /> : null;
            }}
          </Base.Value>
          <Base.Icon className="text-slate">
            <ChevronsUpDown aria-hidden="true" size={16} strokeWidth={1.5} />
          </Base.Icon>
        </Base.Trigger>
        {note && (
          <p
            id={noteId}
            className={`text-[14px] ${error ? "font-semibold text-major" : "text-slate"}`}
          >
            {note}
          </p>
        )}
      </div>
      {/* Base UI waits for a container that is null; undefined means the body. */}
      <Base.Portal container={container ?? undefined}>
        <Base.Positioner alignItemWithTrigger={false} sideOffset={4} className="z-[70]">
          <Base.Popup className="min-w-[var(--anchor-width)] rounded-xl border border-mist bg-surface py-1 text-ink outline-none">
            <Base.List className="max-h-[min(320px,var(--available-height))] overflow-y-auto">
              {options.map((option) => (
                // The global focus ring, drawn inside the item so the list's edge doesn't clip it.
                <Base.Item
                  key={option.value ?? ""}
                  value={option.value}
                  className="grid min-h-[44px] cursor-default grid-cols-[16px_minmax(0,1fr)] items-center gap-2 px-3 text-[16px] -outline-offset-2 select-none data-highlighted:bg-mist"
                >
                  <Base.ItemIndicator className="col-start-1">
                    <Check aria-hidden="true" size={16} strokeWidth={1.5} />
                  </Base.ItemIndicator>
                  <Base.ItemText className="col-start-2">
                    <OptionLabel option={option} />
                  </Base.ItemText>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** The same select bound to a React Hook Form field. */
export function FormSelect<
  T extends FieldValues,
  Out extends FieldValues,
  V extends string | null,
>({
  control: formControl,
  name,
  ...props
}: Omit<SelectProps<V>, "value" | "onChange"> & {
  control: Control<T, unknown, Out>;
  name: Path<T>;
}) {
  const { field, fieldState } = useController<T, Path<T>, Out>({ control: formControl, name });
  return (
    <Select<V>
      {...props}
      value={field.value as V}
      onChange={field.onChange}
      error={props.error ?? fieldState.error?.message}
    />
  );
}
