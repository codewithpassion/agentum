import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import { cx } from "#/lib/cx";

const CONTROL_CLASS =
  "ws-focus w-full rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-text)] text-sm placeholder:text-[var(--ws-muted)]";

export function TextField({
  className,
  hint,
  label,
  ...props
}: { hint?: string; label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label
        className="block font-medium text-[var(--ws-muted)] text-xs"
        htmlFor={id}
      >
        {label}
      </label>
      <input className={cx(CONTROL_CLASS, className)} id={id} {...props} />
      {hint ? <p className="text-[var(--ws-muted)] text-xs">{hint}</p> : null}
    </div>
  );
}

export function TextAreaField({
  className,
  hint,
  label,
  ...props
}: {
  hint?: string;
  label: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label
        className="block font-medium text-[var(--ws-muted)] text-xs"
        htmlFor={id}
      >
        {label}
      </label>
      <textarea
        className={cx(CONTROL_CLASS, "resize-y", className)}
        id={id}
        {...props}
      />
      {hint ? <p className="text-[var(--ws-muted)] text-xs">{hint}</p> : null}
    </div>
  );
}
