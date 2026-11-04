import { LoaderCircleIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Dictation } from "./use-dictation.ts";
export function DictationPreview({ dictation: d }: { dictation: Dictation }) {
  const mirror = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const input = d.inputRef.current;
    const overlay = mirror.current;
    if (!(input && overlay && d.busy)) {
      return;
    }
    const { color, caretColor } = input.style;
    // Read-only textareas still paint their suffix at the old caret. Paint existing
    // text in the mirror too, so inline ghost text makes room without changing the value.
    input.style.color = "transparent";
    input.style.caretColor = "transparent";
    const sync = () => {
      const style = getComputedStyle(input);
      for (const key of [
        "font",
        "letterSpacing",
        "lineHeight",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "borderStyle",
        "boxSizing",
        "textIndent",
        "tabSize",
      ] as const) {
        overlay.style[key] = style[key];
      }
      overlay.style.width = `${input.offsetWidth}px`;
      overlay.style.height = `${input.offsetHeight}px`;
      overlay.scrollTop = input.scrollTop;
      overlay.scrollLeft = input.scrollLeft;
    };
    sync();
    input.addEventListener("scroll", sync);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(input);
    return () => {
      input.removeEventListener("scroll", sync);
      observer?.disconnect();
      input.style.color = color;
      input.style.caretColor = caretColor;
    };
  }, [d.busy, d.inputRef]);
  if (!d.busy) {
    return null;
  }
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-transparent text-transparent"
        ref={mirror}
      >
        <span className="text-foreground" data-dictation-existing="prefix">
          {d.base.slice(0, d.caret)}
        </span>
        <span className="text-muted-foreground italic">
          {d.preview || "\u200b"}
        </span>
        <span className="text-foreground" data-dictation-existing="suffix">
          {d.base.slice(d.end)}
        </span>
      </div>
      <span className="sr-only" role="status">
        {d.preview}
      </span>
      {d.phase === "polishing" ? (
        <span className="pointer-events-none absolute right-2 bottom-2 inline-flex items-center gap-1 bg-background text-muted-foreground text-xs">
          <LoaderCircleIcon className="size-3 animate-spin" />
          Polishing
        </span>
      ) : null}
    </>
  );
}
