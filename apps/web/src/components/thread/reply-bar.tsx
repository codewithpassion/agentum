import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";

/** Smooth scrolling, unless the person asks for reduced motion. */
export const scrollBehaviorFor = (reducedMotion: boolean): ScrollBehavior =>
  reducedMotion ? "auto" : "smooth";

/**
 * A bar at the bottom of a phone screen with a Reply button. It scrolls the
 * element with `targetId` (the thread card) into view and focuses its message
 * box. The bar hides while that message box is on screen. From md up it is hidden.
 */
export function ReplyBar({ targetId }: { targetId: string }) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (target === null) {
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setHidden(entry?.isIntersecting ?? false)
    );
    // Hide only once the message box itself is on screen, not when the top
    // edge of the card peeks in.
    observer.observe(target.querySelector("textarea") ?? target);
    return () => observer.disconnect();
  }, [targetId]);

  const reply = useCallback(() => {
    const target = document.getElementById(targetId);
    if (target === null) {
      return;
    }
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    target.scrollIntoView({
      behavior: scrollBehaviorFor(reducedMotion),
      block: "center",
    });
    target.querySelector("textarea")?.focus({ preventScroll: true });
  }, [targetId]);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-20 border-t bg-card p-3 md:hidden ${hidden ? "hidden" : ""}`}
    >
      <Button className="w-full" onClick={reply} type="button">
        Reply
      </Button>
    </div>
  );
}
