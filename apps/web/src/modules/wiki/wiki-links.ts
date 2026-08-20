import { slugifyPath } from "./slug";

/**
 * `[[Page Title]]` is the wiki-link syntax agents and the user write in page
 * bodies. It is resolved at render time rather than stored as a link, so a page
 * created later turns every existing reference to it live without a rewrite.
 * A slash nests, exactly as in a title: `[[Ops/Runbooks]]` points at
 * `ops/runbooks`.
 */

export const WIKI_PATH_PREFIX = "/wiki/";

const WIKI_LINK = /\[\[([^[\]\n]+)]]/g;
const HREF_SUFFIX = /[?#]/;

export interface WikiLink {
  /** Index of the opening `[[`. */
  index: number;
  slug: string;
  title: string;
}

export const wikiHref = (slug: string): string => `${WIKI_PATH_PREFIX}${slug}`;

/** The slug a `/wiki/...` href points at, or null for any other href. */
export const wikiSlugFromHref = (href: string): string | null => {
  if (!href.startsWith(WIKI_PATH_PREFIX)) {
    return null;
  }
  const slug = href.slice(WIKI_PATH_PREFIX.length).split(HREF_SUFFIX)[0] ?? "";
  return slug.length > 0 ? slug : null;
};

export const parseWikiLinks = (body: string): WikiLink[] => {
  const links: WikiLink[] = [];
  for (const match of body.matchAll(WIKI_LINK)) {
    const title = (match[1] ?? "").trim();
    if (title.length === 0) {
      continue;
    }
    links.push({ index: match.index, slug: slugifyPath(title), title });
  }
  return links;
};

/**
 * Rewrites wiki-links into ordinary markdown links so the markdown renderer
 * handles them; whether the target exists is decided by the link renderer,
 * which knows the page list.
 */
export const replaceWikiLinks = (body: string): string =>
  body.replace(WIKI_LINK, (match, rawTitle: string) => {
    const title = rawTitle.trim();
    if (title.length === 0) {
      return match;
    }
    return `[${title}](${wikiHref(slugifyPath(title))})`;
  });
