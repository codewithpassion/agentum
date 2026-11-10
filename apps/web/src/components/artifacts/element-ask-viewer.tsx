/** biome-ignore-all lint/performance/noJsxPropsBind: Controlled agent selector captures its current value. */

import type { PageElement } from "@repo/protocol/element-ask";
import { useCallback, useEffect, useState } from "react";
import { AgentTranscript } from "#/components/live-artifacts/agent-thread";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { ArtifactFrame, type ArtifactFrameProps } from "./artifact-frame";
import { contentRef } from "./content-ref";

/** Mounted on the authenticated page/dashboard viewer. The iframe cannot choose
 * the target artifact, version, session, actor or role. */
export function ElementAskViewer(props: ArtifactFrameProps) {
  const [session, setSession] =
    useState<RouterOutputs["liveArtifacts"]["session"]>(null);
  const [agents, setAgents] = useState<RouterOutputs["agents"]["list"]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ids = contentRef(props.contentUrl);
  const artifactId = ids?.artifactId;
  const versionId = ids?.versionId;
  const refresh = useCallback(async () => {
    if (!artifactId) {
      return;
    }
    const trpc = getTrpc();
    const [nextSession, nextAgents] = await Promise.all([
      trpc.liveArtifacts.session.query({ artifactId }),
      trpc.agents.list.query({}),
    ]);
    setSession(nextSession);
    setAgents(nextAgents);
  }, [artifactId]);
  useEffect(() => {
    refresh().catch((cause: unknown) =>
      setError(errorMessage(cause, "Could not load agent thread"))
    );
  }, [refresh]);
  const message = useCallback(
    async (
      text: string,
      context?: { element: PageElement; requestId: string }
    ) => {
      if (!(artifactId && versionId && context) || props.preview) {
        throw new Error("Select an element in the current artifact first");
      }
      await getTrpc().liveArtifacts.askElement.mutate({
        ...context,
        artifactId,
        text,
        versionId,
      });
      await refresh();
    },
    [artifactId, versionId, props.preview, refresh]
  );
  return (
    <div className="flex h-full w-full flex-col md:flex-row">
      <ArtifactFrame
        {...props}
        className="min-h-80 min-w-0 flex-1"
        elementAsk
        onMessage={message}
      />
      <aside
        aria-label="Artifact agent thread"
        className="max-h-[30vh] shrink-0 overflow-auto border-border border-l p-3 md:h-full md:max-h-none md:w-80"
      >
        <label>
          Agent
          <select
            aria-label="Artifact agent"
            disabled={busy || props.preview}
            onChange={async (event) => {
              if (!(artifactId && event.target.value)) {
                return;
              }
              setBusy(true);
              try {
                await getTrpc().liveArtifacts.selectAgent.mutate({
                  agentId: event.target.value,
                  artifactId,
                });
                await refresh();
                setError(undefined);
              } catch (cause) {
                setError(errorMessage(cause, "Could not select agent"));
              } finally {
                setBusy(false);
              }
            }}
            value={session?.agentId ?? ""}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <p className="my-2 text-muted-foreground text-sm">
          Use “Select element to ask agent” in the page, click an element, then
          send your question.
        </p>
        {Boolean(props.preview) && (
          <p>Open the current published version to ask about an element.</p>
        )}
        {Boolean(error) && <p role="alert">{error}</p>}
        {session !== null && (
          <AgentTranscript
            agentName={
              agents.find((agent) => agent.id === session.agentId)?.name ??
              "Agent"
            }
            sessionId={session.id}
          />
        )}
      </aside>
    </div>
  );
}
