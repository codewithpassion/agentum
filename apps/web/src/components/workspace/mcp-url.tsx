import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { maskMcpUrl } from "#/lib/format";

const COPIED_RESET_MS = 1500;

/**
 * An agent's MCP URL contains its only credential, so it is masked on screen
 * and only exists client-side right after the token was issued or rotated -
 * there is nothing to show once the page reloads.
 */
export function McpUrlField({
  onRotate,
  rotating,
  url,
}: {
  onRotate?: () => void;
  rotating?: boolean;
  url: string | null;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!url) {
      return;
    }
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [url]);

  return (
    <section className="space-y-1.5">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        MCP URL
      </h3>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2 py-1.5 text-[11px] text-[var(--ws-muted)]"
          data-testid="mcp-url"
          title={url ? maskMcpUrl(url) : undefined}
        >
          {url ? maskMcpUrl(url) : "Hidden — rotate to issue a new one"}
        </code>
        {url ? (
          <Button onClick={copy} size="sm" variant="subtle">
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
        {onRotate ? (
          <Button
            disabled={rotating}
            onClick={onRotate}
            size="sm"
            variant="subtle"
          >
            Rotate
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        {url
          ? "Copy it now — it is shown once. Anyone holding it can act as this agent."
          : "The token is stored hashed and shown only when issued. Rotate it from the edit dialog to get a fresh URL."}
      </p>
    </section>
  );
}
