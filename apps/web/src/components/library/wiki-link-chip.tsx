import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { libraryTarget } from "./wiki-logic.ts";

const CHIP = "rounded px-1 font-semibold";
const LIVE_CHIP = `${CHIP} bg-muted text-foreground hover:bg-muted/70`;
const BROKEN_CHIP = `${CHIP} cursor-pointer bg-destructive/10 text-destructive underline decoration-dotted`;

/** A link to a library path that exists. A wiki page opens in the page view, any other path as a file. */
export function WikiLiveChip({
  children,
  path,
}: {
  children: ReactNode;
  path: string;
}) {
  const search = useCallback(
    (previous: { dir?: string; file?: string; wiki?: string }) => ({
      ...previous,
      ...libraryTarget(path),
    }),
    [path]
  );
  return (
    <Link
      className={LIVE_CHIP}
      data-testid="wiki-link-live"
      search={search}
      to="/library"
    >
      {children}
    </Link>
  );
}

/** A link to a page nobody has written yet: red, dotted underline, and a click starts the page. */
export function WikiBrokenChip({
  children,
  onCreate,
  title,
}: {
  children: ReactNode;
  onCreate: (title: string) => void;
  title: string;
}) {
  const create = useCallback(() => onCreate(title), [onCreate, title]);
  return (
    <button
      className={BROKEN_CHIP}
      data-testid="wiki-link-broken"
      onClick={create}
      title="This page does not exist yet. Click to create it."
      type="button"
    >
      {children}
    </button>
  );
}
