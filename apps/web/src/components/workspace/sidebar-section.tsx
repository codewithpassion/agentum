import { useCallback } from "react";
import { cx } from "#/lib/cx";

/**
 * One collapsible sidebar section. The header is the disclosure control, so the
 * chevron and `aria-expanded` live on the same button.
 */
export function SidebarSection({
  actions,
  children,
  expanded,
  label,
  onToggle,
  sectionKey,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
  expanded: boolean;
  label: string;
  onToggle: (sectionKey: string) => void;
  sectionKey: string;
}) {
  const toggle = useCallback(
    () => onToggle(sectionKey),
    [onToggle, sectionKey]
  );

  return (
    <section>
      <div className="flex items-center gap-1 pt-4 pb-1">
        <button
          aria-expanded={expanded}
          className={cx(
            "ws-focus flex min-w-0 flex-1 items-center gap-1 rounded-lg px-2 py-0.5 text-left",
            "font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide hover:text-[var(--ws-text)]"
          )}
          onClick={toggle}
          type="button"
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="truncate">{label}</span>
        </button>
        {actions}
      </div>
      {expanded ? children : null}
    </section>
  );
}

export function SectionHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">{children}</p>
  );
}
