import { type ReactNode, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function CommandBlock({
  command,
  heading,
  children,
}: {
  command: string;
  heading?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copyCommand = useCallback(async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [command]);

  return (
    <div className="flex flex-col gap-2">
      {heading !== undefined && (
        <p className="font-medium text-sm">{heading}</p>
      )}
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
        {command}
      </pre>
      {children}
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
      <div>
        <Button onClick={copyCommand} size="sm" variant="outline">
          {copied ? "Copied" : "Copy command"}
        </Button>
      </div>
    </div>
  );
}
