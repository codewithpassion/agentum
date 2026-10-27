import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "#/lib/utils.ts";

const CLAMP = { 2: "line-clamp-2", 3: "line-clamp-3" } as const;

/**
 * Text cut to a few lines, with a "Show more" button when it is cut. The button
 * is for phones: from md up the clamp stays as it was and no button shows.
 */
export function ExpandableText({
  children,
  className,
  lines,
}: {
  children: ReactNode;
  className?: string;
  lines: keyof typeof CLAMP;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || expanded) {
      return;
    }
    const measure = () => setCut(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded]);

  const toggle = useCallback(() => setExpanded((value) => !value), []);

  return (
    <>
      <p
        className={cn(
          expanded ? "max-md:line-clamp-none" : null,
          CLAMP[lines],
          className
        )}
        ref={ref}
      >
        {children}
      </p>
      {cut || expanded ? (
        <button
          aria-expanded={expanded}
          className="self-start px-3 pb-1.5 text-primary text-xs underline md:hidden"
          onClick={toggle}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
