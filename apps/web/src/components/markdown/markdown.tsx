import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";

const components: Components = {
  a: ({ href, children }) => (
    <a
      className="underline underline-offset-2"
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

/** Renders markdown as styled, sanitised HTML. Raw HTML in the source is dropped. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
