import { useCallback, useState } from "react";

/** Characters that can overflow four lines on a 360px phone. */
const LONG_DOES = 150;

/**
 * The instruction text, clamped to four lines. On phones a toggle shows all of
 * it. `full` shows all of it with no toggle, for a page whose controls are
 * disabled and would disable the toggle too.
 */
export function DoesText({
  does,
  full = false,
}: {
  does: string;
  full?: boolean;
}) {
  const [expanded, setExpanded] = useState(full);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  if (does === "") {
    return <p className="text-muted-foreground">No instructions yet.</p>;
  }
  return (
    <>
      <p
        className={`whitespace-pre-line max-md:[overflow-wrap:anywhere] ${expanded ? "" : "line-clamp-4"}`}
        data-testid="profile-does"
      >
        {does}
      </p>
      {!full && (does.length > LONG_DOES || does.includes("\n")) ? (
        <button
          aria-expanded={expanded}
          className="mt-1 text-primary text-xs hover:underline md:hidden"
          onClick={toggle}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
