import type { ReactNode } from "react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { headingAnchorIds } from "#/modules/wiki/heading-anchors";
import { nodeText, slugify } from "#/modules/wiki/slug";

export interface MarkdownLinkProps {
  children?: ReactNode;
  href?: string;
}

/** Message links leave the app, so they open in a new tab. */
function ExternalLink({ children, href }: MarkdownLinkProps) {
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

/**
 * Model output sometimes carries citation markup (`<cite index="…">…</cite>`).
 * Raw HTML rendering is disabled, so without this the tags show as literal
 * text; strip the tags and keep the cited text.
 */
const CITE_TAG_RE = /<\/?cite(?:\s[^>]*)?>/g;

export function stripCitationTags(body: string): string {
  return body.replace(CITE_TAG_RE, "");
}

type HeadingTag = "h1" | "h2" | "h3" | "h4";

interface HeadingProps {
  children?: ReactNode;
  /** The parsed node, which carries the heading's line in the source. */
  node?: { position?: { start?: { line?: number } } };
}

/**
 * Ids come from the source line rather than from a render-time counter, so a
 * re-render never renumbers an anchor someone has already linked to.
 */
const headingComponents = (ids: ReadonlyMap<number, string>) => {
  const heading = (Tag: HeadingTag) =>
    function Heading({ children, node }: HeadingProps) {
      const line = node?.position?.start?.line;
      const id =
        (line === undefined ? undefined : ids.get(line)) ??
        slugify(nodeText(children));
      return (
        <Tag id={id}>
          {children}
          <a
            aria-label={`Link to this section: ${nodeText(children)}`}
            className="md-anchor"
            href={`#${id}`}
          >
            #
          </a>
        </Tag>
      );
    };

  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
  };
};

/**
 * Markdown written by users and agents - message bodies and wiki pages. Raw
 * HTML is deliberately not enabled - without `rehype-raw`, react-markdown
 * escapes it, so a body cannot inject markup.
 *
 * `anchors` gives every heading an id plus a hover link, which is what makes
 * `/wiki/page#section` deep links work; `renderLink` lets the wiki resolve its
 * own internal links instead of opening them in a new tab.
 */
export function Markdown({
  anchors = false,
  body,
  renderLink,
}: {
  anchors?: boolean;
  body: string;
  renderLink?: (props: MarkdownLinkProps) => ReactNode;
}) {
  const cleaned = useMemo(() => stripCitationTags(body), [body]);
  const components = useMemo(
    () => ({
      a: renderLink ?? ExternalLink,
      ...(anchors ? headingComponents(headingAnchorIds(cleaned)) : {}),
    }),
    [anchors, cleaned, renderLink]
  );

  return (
    <div className="md-body">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}
