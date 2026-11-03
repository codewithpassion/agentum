import { type ReactNode, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";

const linkClassName = "underline underline-offset-2";

// Only Agentum's own image routes. Absolute URLs never match: the host is unknown during SSR.
const OWN_IMAGE_SRC =
  /^\/files\/[A-Za-z0-9_-]+$|^\/api\/library\/download\?[^\s#]*$/;

export interface MarkdownLinkProps {
  children?: ReactNode;
  href?: string;
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      className={linkClassName}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2 font-semibold text-base last:mb-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 font-semibold text-sm last:mb-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 font-medium text-sm last:mb-0">{children}</h3>
  ),
  img: ({ src, alt }) => {
    if (src && OWN_IMAGE_SRC.test(src)) {
      // biome-ignore lint/correctness/useImageSize: markdown images have no known size; max-w-full keeps them in the column
      return <img alt={alt} className="max-w-full rounded-md" src={src} />;
    }
    return (
      <a
        className={linkClassName}
        href={src || undefined}
        rel="noopener noreferrer"
        target="_blank"
      >
        {src || alt}
      </a>
    );
  },
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs last:mb-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>
  ),
};

function linkRenderer(
  renderLink: (props: MarkdownLinkProps) => ReactNode
): Components["a"] {
  return ({ href, children }) => renderLink({ children, href });
}

/**
 * Renders markdown as styled, sanitised HTML. Raw HTML in the source is dropped.
 * `renderLink` replaces the default anchor; pass a stable function.
 */
export function Markdown({
  children,
  renderLink,
}: {
  children: string;
  renderLink?: (props: MarkdownLinkProps) => ReactNode;
}) {
  const mergedComponents = useMemo<Components>(
    () =>
      renderLink ? { ...components, a: linkRenderer(renderLink) } : components,
    [renderLink]
  );
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown components={mergedComponents} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
