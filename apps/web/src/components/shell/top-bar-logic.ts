import { findEntries, pathOf } from "#/components/rail/find-registry.ts";

export type TopBarLabel = "Home" | "Files" | "Spend";

export interface TopBarLink {
  href: string;
  label: TopBarLabel;
}

/** The pages the top bar links to, in order. Find, Needs you and New agent are not plain pages, so they are not here. */
const HOME_LINK: TopBarLink = { href: "/home", label: "Home" };
const FILES_LINK: TopBarLink = { href: "/library", label: "Files" };
const SPEND_LINK: TopBarLink = { href: "/spend", label: "Spend" };

/** Spend shows only once its page exists. */
export function topBarLinks(hasSpendPage: boolean): readonly TopBarLink[] {
  return hasSpendPage
    ? [HOME_LINK, FILES_LINK, SPEND_LINK]
    : [HOME_LINK, FILES_LINK];
}

const isUnder = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);

/** The top bar link the current page belongs to. */
export function topBarCurrent(pathname: string): TopBarLabel | null {
  for (const link of [HOME_LINK, FILES_LINK, SPEND_LINK]) {
    if (isUnder(pathname, link.href)) {
      return link.label;
    }
  }
  return null;
}

/** Where New agent goes. It is also a Find entry. */
export const NEW_AGENT_HREF = "/agents/new";

/** Pages the top bar reaches that Find does not list, because they do not exist yet. */
const NOT_IN_FIND = new Set(["/spend"]);

/** Every top bar destination that Find must also reach. */
export function topBarTargetsMissingFromFind(): string[] {
  const inFind = new Set(findEntries.map((entry) => pathOf(entry.to)));
  return [...topBarLinks(true).map((link) => link.href), NEW_AGENT_HREF].filter(
    (href) => !(inFind.has(href) || NOT_IN_FIND.has(href))
  );
}

export const findShortcut = (platform: string): string =>
  platform.includes("Mac") ? "⌘K" : "Ctrl K";
