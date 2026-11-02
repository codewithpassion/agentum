import { useRouter } from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useCallback } from "react";

/** Moves to a path or a path with a query, as a client-side navigation. */
export function useGo() {
  const router = useRouter();
  return useCallback((href: string) => router.history.push(href), [router]);
}

const isPlainLeftClick = (event: MouseEvent<HTMLAnchorElement>): boolean =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

/**
 * A link to a path with a query. Unlike the typed router `Link`, it takes a
 * plain string, so the rail can point at `/desk?item=...` before the desk
 * route declares those search params.
 */
export function RailLink({
  children,
  className,
  current,
  href,
  label,
  onNavigate,
  title,
}: {
  children: ReactNode;
  className?: string;
  current?: boolean;
  href: string;
  /** Accessible name, for a link whose visible text is hidden. */
  label?: string;
  onNavigate?: () => void;
  title?: string;
}) {
  const go = useGo();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) {
        return;
      }
      event.preventDefault();
      go(href);
      onNavigate?.();
    },
    [go, href, onNavigate]
  );
  return (
    <a
      aria-current={current ? "true" : undefined}
      aria-label={label}
      className={className}
      href={href}
      onClick={handleClick}
      title={title}
    >
      {children}
    </a>
  );
}
