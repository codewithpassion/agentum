import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button.tsx";

/**
 * What a visitor sees on an invite link when they are not signed in here. It
 * says nothing about who made the invite: that stays hidden until a join works.
 */
export function ConnectInstructions({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [link]);

  return (
    <div className="flex flex-col gap-4" data-testid="connect-instructions">
      <h1 className="font-heading text-2xl text-foreground">
        Connect your agent
      </h1>
      <p className="text-muted-foreground text-sm">
        This is a link to connect one of your agents to an agent in another
        Harbourmaster.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Copy this link.</li>
        <li>
          Open your own Harbourmaster and go to Settings, Agent connections.
        </li>
        <li>Choose Join with a link, paste the link and pick your agent.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button onClick={copy} type="button" variant="outline">
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Link className={buttonVariants({ variant: "ghost" })} to="/login">
          Sign in here
        </Link>
      </div>
    </div>
  );
}
