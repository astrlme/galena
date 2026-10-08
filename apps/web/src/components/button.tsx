import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// At most one primary button per view; `danger` only confirms a deletion in its dialog. Hover
// shifts colour in 120 ms; nothing spins.
const styles = {
  primary: "bg-ink text-paper font-semibold hover:bg-graphite disabled:bg-mist disabled:text-slate",
  secondary:
    "border border-mist bg-surface text-ink hover:border-slate disabled:border-mist disabled:text-slate",
  quiet: "text-ink hover:underline focus-visible:underline",
  danger: "bg-major text-paper font-semibold disabled:bg-mist disabled:text-slate",
} as const;
const base =
  "inline-flex items-center justify-center gap-2 rounded-[6px] px-4 py-2 text-[16px] transition-colors duration-[120ms] motion-reduce:transition-none disabled:cursor-not-allowed";

type Variant = keyof typeof styles;

/** A button's look, for a plain link the browser follows itself (an API route, not a page). */
export const buttonClass = (variant: Variant = "secondary") => `${base} ${styles[variant]}`;

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}

export function ButtonLink({
  href,
  variant = "secondary",
  children,
}: {
  href: string;
  variant?: Variant;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant)}>
      {children}
    </Link>
  );
}
