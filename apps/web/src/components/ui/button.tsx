import type { ButtonHTMLAttributes } from "react";
import { cx } from "#/lib/cx";

type Variant = "danger" | "ghost" | "primary" | "subtle";
type Size = "icon" | "md" | "sm";

const VARIANTS: Record<Variant, string> = {
  danger:
    "border border-[var(--ws-line)] bg-transparent text-[var(--ws-danger)] hover:bg-[color-mix(in_oklab,var(--ws-danger)_14%,transparent)]",
  ghost:
    "border border-transparent bg-transparent text-[var(--ws-muted)] hover:bg-[var(--ws-surface-hover)] hover:text-[var(--ws-text)]",
  primary:
    "border border-transparent bg-[var(--ws-accent)] text-[var(--ws-accent-ink)] hover:brightness-110",
  subtle:
    "border border-[var(--ws-line)] bg-[var(--ws-surface)] text-[var(--ws-text)] hover:bg-[var(--ws-surface-hover)]",
};

const SIZES: Record<Size, string> = {
  icon: "h-7 w-7 justify-center",
  md: "h-9 px-3.5 text-sm",
  sm: "h-7 px-2.5 text-xs",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  variant?: Variant;
}

export function Button({
  className,
  size = "md",
  type = "button",
  variant = "subtle",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cx(
        "ws-focus inline-flex shrink-0 items-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      type={type}
      {...props}
    />
  );
}
