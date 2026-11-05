import {
  Children,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";

/** Copy lives in a header so it never covers a long line of code. */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement);
  const props = code?.props as
    | { className?: string; children?: ReactNode }
    | undefined;
  const language = props?.className?.replace("language-", "") ?? "text";
  const pre = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(pre.current?.textContent ?? "");
    setCopied(true);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, []);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );
  return (
    <div className="mb-2 min-w-0 max-w-full border bg-card last:mb-0">
      <div className="flex items-center justify-between border-b px-3 text-muted-foreground text-xs">
        <span>{language}</span>
        <Button
          className="min-h-10 md:min-h-9"
          onClick={copy}
          size="sm"
          variant="ghost"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-gradient-to-l after:from-card after:to-transparent">
        <pre
          className="overflow-x-auto p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0"
          ref={pre}
        >
          {children}
        </pre>
      </div>
    </div>
  );
}
