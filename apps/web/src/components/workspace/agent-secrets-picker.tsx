import { useUser } from "@clerk/tanstack-react-start";
import { useCallback, useState } from "react";
import { SkillSyncDot } from "#/components/skills/skill-status";
import { hintLabel, hostsLabel, secretDotStatus } from "#/lib/secrets-format";
import { useSecrets } from "#/lib/use-secrets";
import { useActiveWorkspace } from "#/lib/workspace-context";

/**
 * Which of the workspace's secrets this agent may spend (plan §7). Shown for
 * both runtimes, unlike Connectors: the `http_request` tool reads the grant on
 * every call, so a Cloudflare agent can use a secret exactly as a managed one
 * can - only the sandbox environment variable is Anthropic's side of it.
 *
 * Ticking a box writes straight through; there is no Save, because the grant is
 * the whole change and the same click undoes it.
 */

/** Both halves of §7, said where the box is ticked rather than in a doc. */
export const GRANT_TIMING_NOTE =
  "A grant reaches the agent's own tool calls immediately, and a managed agent's sandbox environment variable on its next session.";

/**
 * The §5 caveat, said as it actually is rather than as it sounds better. The
 * secrets vault is per workspace and attaches whole, so a tick here is not an
 * isolation boundary inside a managed sandbox - it is what the tool enforces.
 */
export const SANDBOX_SCOPE_NOTE =
  "Granting a managed agent any secret attaches the workspace's whole secret vault to its sessions: every secret here is then an environment variable in that agent's sandbox, not only the ticked ones. What is ticked is what the agent's own http_request will spend - so treat a managed sandbox, a skill's script as much as the agent itself, as trusted with every key this workspace holds.";

export function AgentSecretsPicker({ agentId }: { agentId: string }) {
  const { api, membership } = useActiveWorkspace();
  const { isSignedIn } = useUser();
  const { error: listError, reload, secrets } = useSecrets(isSignedIn === true);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Grants are owner-gated server-side; a member sees the list and the fact
  // that it is not theirs to change, rather than a checkbox that 403s.
  const canManage = membership?.role === "owner";

  const toggle = useCallback(
    (secretId: string, next: boolean) => {
      setBusyId(secretId);
      setError(null);
      (async () => {
        try {
          if (next) {
            await api.grantSecretToAgent(secretId, agentId);
          } else {
            await api.revokeSecretFromAgent(secretId, agentId);
          }
          await reload();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "That did not work."
          );
        } finally {
          setBusyId(null);
        }
      })();
    },
    [agentId, api, reload]
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      toggle(event.target.value, event.target.checked),
    [toggle]
  );

  const shown = listError ?? error;

  return (
    <div className="space-y-3" data-testid="agent-secrets-picker">
      {secrets.length === 0 ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          No secrets yet. An owner adds them under Secrets in the sidebar.
        </p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {secrets.map((secret) => (
            <li key={secret.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--ws-surface)]">
                <input
                  checked={secret.agentIds.includes(agentId)}
                  className="mt-1"
                  disabled={!canManage || busyId === secret.id}
                  onChange={onChange}
                  type="checkbox"
                  value={secret.id}
                />
                <SkillSyncDot status={secretDotStatus(secret.syncStatus)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {secret.name}{" "}
                    <span className="text-[var(--ws-muted)]">
                      {hintLabel(secret.hint)}
                    </span>
                  </span>
                  <span className="block truncate text-[10px] text-[var(--ws-muted)]">
                    {hostsLabel(secret.allowedHosts)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {canManage ? null : (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          Only an owner can change which secrets an agent holds.
        </p>
      )}

      <p className="m-0 text-[var(--ws-muted)] text-xs">{GRANT_TIMING_NOTE}</p>
      <p className="m-0 text-[var(--ws-muted)] text-xs">{SANDBOX_SCOPE_NOTE}</p>

      {shown ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{shown}</p>
      ) : null}
    </div>
  );
}
