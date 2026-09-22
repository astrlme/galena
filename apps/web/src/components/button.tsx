import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// At most one primary button per view; no colour, no spinners.
const styles = {
  primary: "bg-ink text-paper font-semibold disabled:bg-mist disabled:text-slate",
  secondary: "border border-slate bg-surface text-ink disabled:text-slate",
  quiet: "text-ink hover:underline focus-visible:underline",
} as const;
const base = "inline-flex items-center justify-center rounded-[4px] px-4 py-2 text-[16px]";

type Variant = keyof typeof styles;

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
    <Link href={href} className={`${base} ${styles[variant]}`}>
      {children}
    </Link>
  );
}
