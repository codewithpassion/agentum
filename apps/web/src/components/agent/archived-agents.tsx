import { RAIL_REFRESH_EVENT } from "@repo/db/shared";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

interface ArchivedAgent {
  id: string;
  name: string;
  slug: string;
}

function RestoreAgentButton({
  agent,
  onRestored,
}: {
  agent: ArchivedAgent;
  onRestored?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const restore = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await getTrpc().agents.restore.mutate({ agentId: agent.id });
      toast.success(`Restored ${agent.name}`);
      onRestored?.();
      window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
      await router.invalidate();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [agent.id, agent.name, onRestored, router]);

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <Button
        className="min-h-10"
        disabled={pending}
        onClick={restore}
        variant="outline"
      >
        {pending ? "Restoring…" : "Restore"}
      </Button>
      {error === undefined ? null : (
        <p className="max-w-64 text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ArchivedAgents({
  agents,
  onRestored,
}: {
  agents: ArchivedAgent[];
  onRestored?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  if (agents.length === 0) {
    return null;
  }
  return (
    <div className="mt-6">
      <Button
        aria-expanded={open}
        className="min-h-10 text-muted-foreground"
        onClick={toggle}
        variant="ghost"
      >
        Archived ({agents.length})
      </Button>
      {open ? (
        <ul className="mt-2 divide-y divide-border">
          {agents.map((agent) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              key={agent.id}
            >
              <div className="min-w-0 flex-1 break-words">
                <Link
                  className="inline-flex min-h-10 items-center font-medium"
                  params={{ agentId: agent.id }}
                  to="/agents/$agentId"
                >
                  {agent.name}
                </Link>
                <div className="text-muted-foreground text-xs">
                  <code>{agent.slug}</code>
                </div>
              </div>
              <RestoreAgentButton agent={agent} onRestored={onRestored} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ArchivedAgentBanner({ agent }: { agent: ArchivedAgent }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted p-4">
      <p className="min-w-0 flex-[1_1_240px] text-sm">
        This agent is archived. It doesn't run and isn't offered anywhere.
      </p>
      <RestoreAgentButton agent={agent} />
    </div>
  );
}
