import { wikiSlugFromHref } from "@repo/services/wiki/links";
import type {
  WikiPageNodeRecord,
  WikiPageRecord,
} from "#/integrations/trpc/types";
import { parentDir } from "./library-logic.ts";

const PAGE_EXTENSION = ".md";
const INDENT = "  ";

/** One line of the wiki tree, with its depth below the top level. */
export interface WikiTreeRow {
  depth: number;
  /** A page has its own .md file. Otherwise the node is only a folder that holds pages. */
  isPage: boolean;
  node: WikiPageNodeRecord;
}

/** True for a library path that is a wiki page file. */
export const isWikiPage = (path: string): boolean =>
  path.startsWith("wiki/") && path.endsWith(PAGE_EXTENSION);

/** The tree in reading order: a page, then its children, one row each. */
export const flattenWikiTree = (
  nodes: readonly WikiPageNodeRecord[],
  depth = 0
): WikiTreeRow[] =>
  nodes.flatMap((node) => [
    { depth, isPage: isWikiPage(node.path), node },
    ...flattenWikiTree(node.children, depth + 1),
  ]);

/** What the New page dialog offers as a parent: the top level, then every node, indented by depth. */
export const wikiParentOptions = (
  nodes: readonly WikiPageNodeRecord[]
): { label: string; value: string }[] => [
  { label: "Top level", value: "" },
  ...flattenWikiTree(nodes).map(({ depth, node }) => ({
    label: `${INDENT.repeat(depth)}${node.title}`,
    value: node.path,
  })),
];

type PageLink = WikiPageRecord["links"][number];

/** How a link inside a page renders: a wiki-link chip, or an ordinary link. */
export type LinkChip =
  | { broken: boolean; kind: "wiki"; path: string; title: string }
  | { kind: "external" };

/**
 * Maps a rendered link to its chip. `[[links]]` reach the renderer as `/wiki/<slug>`
 * hrefs, and the page's resolved `links` say whether each target exists.
 */
export const wikiLinkChip = (
  href: string | undefined,
  links: readonly PageLink[]
): LinkChip => {
  const slug = href === undefined ? null : wikiSlugFromHref(href);
  if (slug === null) {
    return { kind: "external" };
  }
  const link = links.find((candidate) => candidate.slug === slug);
  if (link === undefined) {
    return {
      broken: true,
      kind: "wiki",
      path: `wiki/${slug}${PAGE_EXTENSION}`,
      title: slug,
    };
  }
  return {
    broken: link.broken,
    kind: "wiki",
    path: link.path,
    title: link.title,
  };
};

/** The library page's search params for opening a resolved path: a wiki page, or any other file. */
export const libraryTarget = (
  path: string
): { dir?: string; file?: string; wiki?: string } => {
  if (isWikiPage(path)) {
    return { wiki: path };
  }
  const dir = parentDir(path);
  return { dir: dir === "" ? undefined : dir, file: path };
};
