import type { Operation } from "@repo/live-doc";
import { fromMarkdown, markdownImageUrls } from "@repo/live-doc/schema";

const OWN_FILE = /^\/files\/[A-Za-z0-9_-]+$/;
const markdownOf = (op: Operation): string | undefined => {
  if (!("content" in op && op.content && "markdown" in op.content)) {
    return;
  }
  return op.content.markdown;
};

export const editMarkdownImageUrls = (ops: Operation[]): string[] => {
  const urls = new Set<string>();
  for (const op of ops) {
    const markdown = markdownOf(op);
    if (markdown === undefined) {
      continue;
    }
    for (const url of markdownImageUrls(markdown)) {
      urls.add(url);
    }
  }
  return [...urls];
};

export const withStoredImages = (
  ops: Operation[],
  replacements: ReadonlyMap<string, string>
): Operation[] => {
  return ops.map((op) => {
    const markdown = markdownOf(op);
    if (
      markdown === undefined ||
      !markdownImageUrls(markdown).some((url) => replacements.has(url))
    ) {
      return op;
    }
    // Already-owned /files/ images stay; the room re-sanitizes against its own policy.
    const ownBlobUrls = new Set([
      ...replacements.values(),
      ...markdownImageUrls(markdown).filter((url) => OWN_FILE.test(url)),
    ]);
    return {
      ...op,
      content: {
        json: fromMarkdown(markdown, { ownBlobUrls }, replacements),
      },
    };
  });
};
