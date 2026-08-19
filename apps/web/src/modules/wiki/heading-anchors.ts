import { createHeadingSlugger } from "./slug";

/**
 * Heading anchors are derived from the markdown source, keyed by the line the
 * heading sits on, rather than counted while rendering: a component can render
 * more than once for the same document, and a counter would then hand the same
 * heading a different `-1`, `-2` id each time and break existing deep links.
 */

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const CLOSING_HASHES = /\s+#+\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

export interface HeadingAnchor {
  id: string;
  level: number;
  /** 1-based, matching the position the markdown parser reports. */
  line: number;
  text: string;
}

export const headingAnchors = (markdown: string): HeadingAnchor[] => {
  const slugFor = createHeadingSlugger();
  const anchors: HeadingAnchor[] = [];
  let fence: string | null = null;

  markdown.split("\n").forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      // A fence of the same kind closes the block; anything else stays inside it.
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      return;
    }
    if (fence !== null) {
      return;
    }

    const match = ATX_HEADING.exec(line);
    if (!match) {
      return;
    }
    const text = (match[2] ?? "").replace(CLOSING_HASHES, "").trim();
    anchors.push({
      id: slugFor(text),
      level: (match[1] ?? "").length,
      line: index + 1,
      text,
    });
  });

  return anchors;
};

/** The lookup a renderer needs: source line -> heading id. */
export const headingAnchorIds = (markdown: string): Map<number, string> =>
  new Map(headingAnchors(markdown).map((anchor) => [anchor.line, anchor.id]));
