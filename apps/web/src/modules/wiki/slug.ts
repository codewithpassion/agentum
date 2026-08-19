/**
 * Slugs are used for two things: page addresses (`/wiki/<slug>`) and heading
 * anchors (`/wiki/<slug>#<heading>`). Both follow the GitHub rules - lowercase,
 * spaces to dashes, punctuation dropped - so a page slug and a heading slug are
 * produced by the same function and read the same way.
 */

const DASHES = /[\s_-]+/g;
const NON_SLUG_CHARACTERS = /[^\p{L}\p{N}\s_-]+/gu;
const EDGE_DASHES = /^-+|-+$/g;

/** Fallback for titles made entirely of punctuation ("!!!" or "***"). */
export const EMPTY_SLUG_FALLBACK = "untitled";

export const slugify = (text: string): string => {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(NON_SLUG_CHARACTERS, "")
    .replace(DASHES, "-")
    .replace(EDGE_DASHES, "");
  return slug.length > 0 ? slug : EMPTY_SLUG_FALLBACK;
};

/**
 * Heading anchors have to be unique within one document, so repeated headings
 * get `-1`, `-2`, ... exactly like GitHub. The counter is per document: create a
 * slugger per render pass, never share one.
 */
export const createHeadingSlugger = (): ((text: string) => string) => {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
};

/** Flattens a React heading child tree (or any node) down to its text. */
export const nodeText = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(nodeText).join("");
  }
  if (node && typeof node === "object" && "props" in node) {
    const { props } = node as { props?: { children?: unknown } };
    return nodeText(props?.children);
  }
  return "";
};
