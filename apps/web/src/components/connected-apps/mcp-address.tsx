import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { errorMessage } from "#/lib/error-message";

/** This workspace's own MCP address, with a copy button. */
export function McpAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = useCallback(async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [url]);

  return (
    <div className="mb-6 flex flex-col gap-2">
      <p className="font-medium text-sm">This workspace&apos;s MCP address</p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
          {url}
        </pre>
        <Button onClick={copy} size="sm" variant="outline">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
      <p className="text-muted-foreground text-sm">
        Connect a client to this address to use it in this workspace, and
        approve it here.
      </p>
    </div>
  );
}
