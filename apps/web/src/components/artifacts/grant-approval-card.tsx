import { useCallback, useState } from "react";
import { expiryText } from "#/components/requests/request-card-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client.ts";
import {
  decideAll,
  type GrantDecision,
  type PromoteApproval,
} from "./grant-approval-model.ts";
import { errorMessage } from "./share-model.ts";

function AccessList({ items, label }: { items: string[]; label: string }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-xs">{label}</p>
      <ul className="list-disc pl-5 text-xs">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

interface GrantApprovalViewProps {
  busy: boolean;
  error: string | null;
  expiresText: string;
  items: PromoteApproval;
  onApprove: () => void;
  onReject: () => void;
}

/** The card's content: what the version asks for and the two answers. */
export function GrantApprovalView({
  busy,
  error,
  expiresText,
  items,
  onApprove,
  onReject,
}: GrantApprovalViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-semibold">
        {`${items.title} v${items.version} asks for access`}
      </p>
      <AccessList items={items.tools} label="Tools" />
      <AccessList items={items.hosts} label="Hosts" />
      <AccessList items={items.secrets} label="Secrets" />
      {items.endpoints.map((name) => (
        <p
          className="text-xs"
          key={`endpoint:${name}`}
        >{`Public address: ${name}`}</p>
      ))}
      {items.agents.map((agentId) => (
        <p
          className="text-xs"
          key={`agent:${agentId}`}
        >{`Hand off to agent ${agentId}`}</p>
      ))}
      <p className="text-muted-foreground text-xs">{expiresText}</p>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          className="h-10 md:h-7"
          disabled={busy}
          onClick={onApprove}
          size="sm"
          type="button"
        >
          Approve
        </Button>
        <Button
          className="h-10 md:h-7"
          disabled={busy}
          onClick={onReject}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

interface GrantApprovalCardProps {
  expiresAt: string;
  items: PromoteApproval;
  nowMs: number;
  onChanged: () => void;
}

/** Approves or rejects every grant a proposed app version asks for. */
export function GrantApprovalCard({
  expiresAt,
  items,
  nowMs,
  onChanged,
}: GrantApprovalCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: GrantDecision) => {
      setBusy(true);
      setError(null);
      try {
        await decideAll(items.grantIds, decision, (grantId, value) =>
          getTrpc().artifacts.decideGrant.mutate({ decision: value, grantId })
        );
        onChanged();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [items.grantIds, onChanged]
  );

  const approve = useCallback(() => decide("approved"), [decide]);
  const reject = useCallback(() => decide("rejected"), [decide]);

  return (
    <GrantApprovalView
      busy={busy}
      error={error}
      expiresText={expiryText(expiresAt, nowMs)}
      items={items}
      onApprove={approve}
      onReject={reject}
    />
  );
}
