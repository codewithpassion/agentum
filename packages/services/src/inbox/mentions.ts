export const MAX_MENTIONS = 10;

const MIN_SLUG_LENGTH = 2;
const MAX_SLUG_LENGTH = 40;

// An "@" not preceded by a letter, digit, underscore or "@". The slug is
// lowercase or uppercase ASCII letters and digits, with single hyphens
// between them. A trailing hyphen is left out of the match.
const MENTION_PATTERN =
  /(?<![\p{L}\p{N}_@])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/gu;

/** Distinct agent slugs named as "@slug" in `text`, in order of first appearance. */
export const parseMentions = (text: string): string[] => {
  const slugs = new Set<string>();

  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (slugs.size >= MAX_MENTIONS) {
      break;
    }
    const slug = match[1]?.toLowerCase();
    if (
      slug === undefined ||
      slug.length < MIN_SLUG_LENGTH ||
      slug.length > MAX_SLUG_LENGTH
    ) {
      continue;
    }
    slugs.add(slug);
  }

  return [...slugs];
};
