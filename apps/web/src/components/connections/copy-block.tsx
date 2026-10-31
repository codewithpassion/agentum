import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

/** A labelled, read-only block of text with a Copy button. */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copyText = useCallback(async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [text]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <Button onClick={copyText} size="sm" variant="outline">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
        {text}
      </pre>
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
