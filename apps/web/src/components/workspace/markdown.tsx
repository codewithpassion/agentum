import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Message bodies are markdown written by users and (from phase 2) agents. Raw
 * HTML is deliberately not enabled - without `rehype-raw`, react-markdown
 * escapes it, so a body cannot inject markup.
 */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noopener noreferrer" target="_blank">
              {children}
            </a>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
