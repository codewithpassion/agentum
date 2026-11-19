import { useCallback, useState } from "react";

/** Characters that can overflow four lines on a 360px phone. */
const LONG_DOES = 150;

/** The instruction text, clamped to four lines. On phones a toggle shows all of it. */
export function DoesText({ does }: { does: string }) {
  const [expanded, setExpanded] = useState(false);
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
      {does.length > LONG_DOES || does.includes("\n") ? (
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
