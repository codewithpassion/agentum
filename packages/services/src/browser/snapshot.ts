/** UTF-8 truncation keeps complete code points at the context boundary. */
const truncateText = (
  value: string,
  limit: number
): { text: string; truncated: boolean } => {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= limit) {
    return { text: value, truncated: false };
  }
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > limit) {
      break;
    }
    text += character;
    bytes += size;
  }
  return { text, truncated: true };
};

/**
 * A page as an agent reads it: title, address, visible text and the links it
 * could follow next. Kitesurf and Chromium both render for a human; this is the
 * translation into something a model can act on without a screenshot.
 *
 * Pure on purpose - the raw shape comes out of the page in `session.ts`, and
 * everything that bounds it for a model's context happens here.
 */

/** What one snapshot hands back to an agent. */
export const MAX_SNAPSHOT_TEXT_BYTES = 12_000;
export const MAX_SNAPSHOT_LINKS = 60;
const MAX_LINK_TEXT_LENGTH = 120;
const SUMMARY_TEXT_MAX_BYTES = 300;

export interface SnapshotLink {
  href: string;
  text: string;
}

/** Straight off the page, before any capping. */
export interface RawSnapshot {
  links: SnapshotLink[];
  text: string;
  title: string;
  url: string;
}

export interface PageSnapshot extends RawSnapshot {
  /** True when links were dropped to fit `MAX_SNAPSHOT_LINKS`. */
  linksTruncated: boolean;
  /** True when the text was cut to fit `MAX_SNAPSHOT_TEXT_BYTES`. */
  textTruncated: boolean;
}

const WHITESPACE = /\s+/g;

const collapse = (text: string): string => text.replace(WHITESPACE, " ").trim();

const BLANK_LINES = /\n{3,}/g;

/** Keeps paragraph breaks (they carry structure) but drops the runs of blanks. */
const tidyText = (text: string): string =>
  text.replace(BLANK_LINES, "\n\n").trim();

// The supplied port source uses visible text and links rather than an aria tree.
// Preserve that format; adapters can supply aria snapshot text in raw.text.
export const buildSnapshot = (raw: RawSnapshot): PageSnapshot => {
  const text = truncateText(tidyText(raw.text), MAX_SNAPSHOT_TEXT_BYTES);
  const links = raw.links
    .map((link) => ({
      href: link.href,
      text: collapse(link.text).slice(0, MAX_LINK_TEXT_LENGTH),
    }))
    .filter((link) => link.href.length > 0);

  return {
    links: links.slice(0, MAX_SNAPSHOT_LINKS),
    linksTruncated: links.length > MAX_SNAPSHOT_LINKS,
    text: text.text,
    textTruncated: text.truncated,
    title: collapse(raw.title),
    url: raw.url,
  };
};

/**
 * One line plus the head of the page, for a tool result that is meant to orient
 * an agent rather than give it everything (`browser_snapshot` gives it
 * everything).
 */
export const summarizeSnapshot = (snapshot: PageSnapshot): string => {
  const head = truncateText(
    collapse(snapshot.text),
    SUMMARY_TEXT_MAX_BYTES
  ).text;
  const linkCount = snapshot.links.length;
  const suffix = snapshot.linksTruncated ? "+" : "";
  return `${snapshot.title || "(untitled)"} - ${snapshot.url}\n${head}\n[${linkCount}${suffix} links; use browser_snapshot for the full page]`;
};
