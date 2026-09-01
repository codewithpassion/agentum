import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  type ContainerEngine,
  computerdRunCommand,
} from "#/lib/computer-hosts";

const COPIED_RESET_MS = 1500;

/**
 * The one-time token, inside the command that uses it. The token is stored
 * hashed, so this screen is the only place it will ever exist in plaintext -
 * which is why the command, not the bare token, is what gets copied: the token
 * on its own is not something anybody needs to keep.
 */

function CommandBlock({
  engine,
  token,
  url,
}: {
  engine: ContainerEngine;
  token: string;
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  const command = computerdRunCommand(engine, { token, url });

  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [command]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
          {engine}
        </h4>
        <Button onClick={copy} size="sm" variant="subtle">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        className="m-0 overflow-x-auto rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[11px] leading-5"
        data-testid={`computerd-command-${engine}`}
      >
        <code>{command}</code>
      </pre>
    </div>
  );
}

export function ComputerTokenPanel({ token }: { token: string }) {
  const url = window.location.origin;

  return (
    <section className="space-y-3">
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        Run this on the machine that should be the computer. The token is shown
        once and is stored hashed — there is no way to see it again, only to
        rotate it for a new one.
      </p>
      <CommandBlock engine="docker" token={token} url={url} />
      <CommandBlock engine="podman" token={token} url={url} />
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        The named volume is the computer: everything under{" "}
        <code>/home/agent</code> survives a restart or a new image, and
        everything outside it does not. Under rootless Podman,{" "}
        <code>--userns=keep-id</code> keeps the volume readable from your own
        user. The container dials out to Agentum, so it needs no inbound port.
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        The container runs whatever the agent decides to run, with the network
        access the container has. The memory and CPU caps and the container
        boundary are the guard rails; which machine and which network it sits on
        are yours to choose.
      </p>
    </section>
  );
}
