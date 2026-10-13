import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  type ComputerImageVariant,
  computerRunCommand,
  SECCOMP_PROFILE_URL,
} from "#/lib/computer-hosts";

const COPIED_RESET_MS = 1500;

const VARIANT_LABELS: Record<ComputerImageVariant, string> = {
  base: "Base image",
  desktop: "Desktop image",
};

/**
 * The one-time enrollment code, inside the command that uses it. The code is
 * stored hashed, expires after 15 minutes and works once, so this screen is the
 * only place it will ever exist in plaintext - which is why the command, not
 * the bare code, is what gets copied.
 */

function CommandBlock({
  code,
  url,
  variant,
}: {
  code: string;
  url: string;
  variant: ComputerImageVariant;
}) {
  const [copied, setCopied] = useState(false);
  const command = computerRunCommand(variant, { code, url });

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
          {VARIANT_LABELS[variant]}
        </h4>
        <Button onClick={copy} size="sm" variant="subtle">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        className="m-0 overflow-x-auto rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[11px] leading-5"
        data-testid={`computer-command-${variant}`}
      >
        <code>{command}</code>
      </pre>
    </div>
  );
}

export function ComputerTokenPanel({ code }: { code: string }) {
  const url = window.location.origin;

  return (
    <section className="space-y-3">
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        Run one of these on the machine that should be the computer. The
        enrollment code is shown once, works once, and expires in 15 minutes. If
        it lapses or gets lost, re-enroll the host for a new one.
      </p>
      <CommandBlock code={code} url={url} variant="base" />
      <CommandBlock code={code} url={url} variant="desktop" />
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        The desktop image runs Chromium, whose sandbox needs user namespaces
        that Docker's default seccomp profile refuses. Download{" "}
        <a
          className="underline"
          href={SECCOMP_PROFILE_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          seccomp.json
        </a>{" "}
        next to where you run the command, or change the path after{" "}
        <code>seccomp=</code>.
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        The named volume holds the machine credential the client receives when
        it enrolls, so a restart or a new image reconnects without a new code.
        The container dials out to Agentum, so it needs no inbound port.
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        The container runs whatever the agent decides to run, with the network
        access the container has. The container boundary is the guard rail;
        which machine and which network it sits on are yours to choose.
      </p>
    </section>
  );
}
