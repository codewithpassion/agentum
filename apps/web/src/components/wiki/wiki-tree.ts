import type { WikiPageSummary } from "#/lib/api";

/**
 * The wiki's hierarchy lives in the slugs: a page at `ops/runbooks/deploy` sits
 * under Ops > Runbooks. Nothing is stored about folders, so the tree is derived
 * from the page list - which also means a folder exists exactly as long as
 * something is inside it.
 */
export interface WikiTreeNode {
  /** Sorted by label; empty for a node that is only a page. */
  children: WikiTreeNode[];
  /** The page written at this path, if there is one. A node can be both. */
  page: WikiPageSummary | null;
  /** The full address, e.g. `ops/runbooks`. */
  path: string;
  /** The last part of the path, e.g. `runbooks`. */
  segment: string;
}

/** A page shows its title; a folder has only its segment to go by. */
export const wikiNodeLabel = (node: WikiTreeNode): string =>
  node.page ? node.page.title : node.segment;

const byLabel = (a: WikiTreeNode, b: WikiTreeNode): number =>
  wikiNodeLabel(a).localeCompare(wikiNodeLabel(b));

const sortTree = (nodes: WikiTreeNode[]): WikiTreeNode[] => {
  nodes.sort(byLabel);
  for (const node of nodes) {
    sortTree(node.children);
  }
  return nodes;
};

export const buildWikiTree = (pages: WikiPageSummary[]): WikiTreeNode[] => {
  const roots: WikiTreeNode[] = [];
  const byPath = new Map<string, WikiTreeNode>();

  for (const page of pages) {
    const segments = page.slug.split("/").filter((part) => part.length > 0);
    let parent: WikiTreeNode | null = null;
    let path = "";

    for (const segment of segments) {
      path = path.length > 0 ? `${path}/${segment}` : segment;
      let node = byPath.get(path);
      if (!node) {
        node = { children: [], page: null, path, segment };
        byPath.set(path, node);
        (parent ? parent.children : roots).push(node);
      }
      parent = node;
    }

    if (parent) {
      parent.page = page;
    }
  }

  return sortTree(roots);
};

/** The direct children of a path, for the index a folder shows in place of a page. */
export const wikiFolderChildren = (
  pages: WikiPageSummary[],
  path: string
): WikiTreeNode[] => {
  let nodes = buildWikiTree(pages);
  for (const segment of path.split("/").filter((part) => part.length > 0)) {
    const next = nodes.find((node) => node.segment === segment);
    if (!next) {
      return [];
    }
    nodes = next.children;
  }
  return nodes;
};
