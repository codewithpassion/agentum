import { LoaderCircleIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Dictation } from "./use-dictation.ts";

const pixels = (value: string) => Number.parseFloat(value) || 0;
export function DictationPreview({ dictation: d }: { dictation: Dictation }) {
  const mirror = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const value = useRef(d.base);
  value.current = d.base;
  useLayoutEffect(() => {
    const input = d.inputRef.current;
    const overlay = mirror.current;
    if (!(input && overlay && d.busy)) {
      return;
    }
    const { color, caretColor, height } = input.style;
    const { placeholder } = input;
    const initialStyle = getComputedStyle(input);
    const bottomPadding = initialStyle.paddingBottom;
    const initialHeight =
      input.offsetHeight || Number.parseFloat(initialStyle.height) || 0;
    input.placeholder = "";
    // Keep the controlled model untouched, but give the read-only textarea the same
    // display text as the mirror so its native scroll range includes the preview.
    input.value = d.base.slice(0, d.caret) + d.preview + d.base.slice(d.end);
    // Paint existing text in the mirror too, so the suffix follows the ghost text.
    input.style.color = "transparent";
    input.style.caretColor = "transparent";
    const sync = () => {
      const style = getComputedStyle(input);
      for (const key of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "wordSpacing",
        "textTransform",
        "whiteSpace",
        "overflowWrap",
        "wordBreak",
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
      const horizontalPadding =
        pixels(style.paddingLeft) + pixels(style.paddingRight);
      overlay.style.boxSizing = "content-box";
      overlay.style.borderWidth = "0";
      overlay.style.left = style.borderLeftWidth;
      overlay.style.top = style.borderTopWidth;
      overlay.style.paddingBottom = bottomPadding;
      overlay.style.width = `${input.clientWidth - horizontalPadding}px`;
      overlay.style.height = `${input.clientHeight - pixels(style.paddingTop) - pixels(bottomPadding)}px`;
    };
    const scroll = () => {
      overlay.scrollTop = input.scrollTop;
      overlay.scrollLeft = input.scrollLeft;
    };
    const grow = () => {
      sync();
      const style = getComputedStyle(input);
      const borders =
        pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
      const padding = pixels(style.paddingTop) + pixels(bottomPadding);
      const max =
        Number.parseFloat(style.maxHeight) || Number.POSITIVE_INFINITY;
      const adjustment = style.boxSizing === "border-box" ? borders : -padding;
      input.style.height = `${Math.min(max, Math.max(initialHeight + (style.boxSizing === "border-box" ? 0 : -padding - borders), overlay.scrollHeight + adjustment))}px`;
      sync();
      const end = ghost.current;
      const previewBottom = end?.offsetHeight
        ? end.offsetTop + end.offsetHeight
        : overlay.scrollHeight;
      input.scrollTop = Math.max(0, previewBottom - input.clientHeight);
      scroll();
    };
    grow();
    input.addEventListener("scroll", scroll);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(grow);
    observer?.observe(input);
    return () => {
      input.removeEventListener("scroll", scroll);
      observer?.disconnect();
      input.placeholder = placeholder;
      input.style.height = height;
      input.value = value.current;
      input.style.color = color;
      input.style.caretColor = caretColor;
    };
  });
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
        <span className="text-muted-foreground italic" ref={ghost}>
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
