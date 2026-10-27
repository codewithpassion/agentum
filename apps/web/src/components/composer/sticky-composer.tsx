import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * How far the on-screen keyboard covers the bottom of the layout viewport, in
 * px. Browsers that resize the layout viewport for the keyboard report 0.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return;
    }
    const update = () =>
      setInset(
        Math.max(
          0,
          Math.round(window.innerHeight - viewport.height - viewport.offsetTop)
        )
      );
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/**
 * Keeps a composer at the bottom of the screen on phones and above the
 * on-screen keyboard. From md up it is a plain block.
 */
export function StickyComposer({
  background,
  children,
}: {
  /** The tailwind background of the surface behind it, so the bar covers the thread. */
  background: "bg-background" | "bg-card";
  children: ReactNode;
}) {
  const inset = useKeyboardInset();
  const style = { "--keyboard-inset": `${inset}px` } as CSSProperties;
  return (
    <div
      className={cn(
        "sticky bottom-[var(--keyboard-inset)] z-10 border-t pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:static md:border-t-0 md:bg-transparent md:p-0",
        background
      )}
      style={style}
    >
      {children}
    </div>
  );
}
