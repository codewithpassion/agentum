/** biome-ignore-all lint/performance/noJsxPropsBind: Page actions capture current artifact and selection. */

import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "#/lib/error-message";
import type { LiveOutputs } from "../live-artifacts/live-api";
import { liveApi } from "../live-artifacts/live-api";
import { ExportControls } from "../live-exports/export-controls";
import { DeckCollaboration } from "./deck-collaboration";
import { DeckRefusalNotice, isStaleAncestry } from "./deck-refusal-notice.tsx";
import { deckServices } from "./deck-services";
import type { DeckWhere } from "./ports";
import { TicketedDeckRoom } from "./room-provider";
import { DeckRuntimeGate } from "./runtime-gate";
import "./deck-page.css";

export function LiveDeckPage({
  artifactId,
  title,
}: {
  artifactId: string;
  title: string;
}) {
  const services = useMemo(() => deckServices(artifactId), [artifactId]);
  const [attempt, setAttempt] = useState(0);
  const [room, setRoom] = useState<TicketedDeckRoom>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [intent, setIntent] = useState<{
    kind: "ask" | "comment";
    where: DeckWhere;
  }>();
  const [versions, setVersions] = useState<LiveOutputs["history"]>();
  const [confirm, setConfirm] = useState<number>();
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt deliberately replaces all optimistic state.
  useEffect(() => {
    setRoom(undefined);
    setError(undefined);
    setIntent(undefined);
    const provider = new TicketedDeckRoom({
      failed: (message) => {
        setRoom(undefined);
        setError(message);
      },
      join: async () => {
        const opened = await services.open();
        if (opened.kind !== "deck") {
          throw new Error("Artifact is not a deck");
        }
        return liveApi.join.mutate({ artifactId });
      },
      policy: services.policy,
      ready: (connected) => setRoom(connected),
      roleChanged: () => setRevision((old) => old + 1),
    });
    const unsubscribe = provider.subscribe(() => setRevision((old) => old + 1));
    provider.connect();
    return () => {
      unsubscribe();
      provider.dispose();
      setTimeout(() => {
        provider.deck.destroy();
        provider.document.destroy();
      }, 0);
    };
  }, [artifactId, attempt, services]);
  const editable = room?.role === "owner" || room?.role === "editor";
  useEffect(() => {
    if (!editable) {
      setConfirm(undefined);
    }
  }, [editable]);
  const select = async (kind: "ask" | "comment", where: DeckWhere) => {
    room?.publishPresence({
      selection: where.elementIds,
      slideId: where.slideId,
    });
    setIntent({ kind, where });
    await Promise.resolve();
  };
  const restore = async () => {
    if (confirm === undefined || !editable || busy) {
      return;
    }
    setBusy(true);
    try {
      await services.restore(confirm);
      setVersions(undefined);
      setConfirm(undefined);
      setAttempt((old) => old + 1);
    } catch (cause) {
      setError(errorMessage(cause, "Restore failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="live-deck-page" data-revision={revision}>
      <header>
        <a href="/artifacts">Artifacts</a>
        <h1>{title}</h1>
        <span>{room ? `Connected · ${room.role}` : "Disconnected"}</span>
      </header>
      <ExportControls
        artifactId={artifactId}
        connected={room !== undefined}
        key={artifactId}
        kind="deck"
      />
      {isStaleAncestry(error) && (
        <DeckRefusalNotice onReload={() => setAttempt((old) => old + 1)} />
      )}
      {Boolean(error) && !isStaleAncestry(error) && (
        <div role="alert">
          <p>{error}</p>
          <p>
            Reconnect reloads accepted state and discards unaccepted local
            edits.
          </p>
          <button onClick={() => setAttempt((old) => old + 1)} type="button">
            Reconnect
          </button>
        </div>
      )}
      <DeckRuntimeGate
        runtime={
          room
            ? {
                ports: {
                  ask: (where) => select("ask", where),
                  comment: (where) => select("comment", where),
                  deck: room.deck,
                  embedSources: [...room.policy.ownBlobUrls].filter((source) =>
                    source.startsWith("artifact:")
                  ),
                  ensureCell: async (slideId, elementId, key) => {
                    const result = await services.ensureCell(
                      slideId,
                      elementId,
                      key
                    );
                    await room.applyAuthority(result.state);
                  },
                  history: async () => {
                    setVersions(await services.history());
                  },
                  ownsBlob: (path) => room.policy.ownBlobUrls.has(path),
                  participants: room.participants,
                  presentation: room.presentation,
                  presentToEveryone: room.presentToEveryone,
                  provider: {
                    publishPresence: room.publishPresence,
                    state: "synced",
                  },
                  resolveEmbed: services.resolveEmbed,
                  role: room.role,
                  selfId: room.selfId,
                  upload: async (file) => {
                    const result = await services.upload(file);
                    await room.refreshOwnership();
                    if (!room.policy.ownBlobUrls.has(result.path)) {
                      throw new Error(
                        "Uploaded image ownership was not confirmed"
                      );
                    }
                    return result;
                  },
                },
                state: "ready",
              }
            : { state: "loading" }
        }
      />
      {room !== undefined && (
        <DeckCollaboration
          artifactId={artifactId}
          intent={intent}
          room={room}
        />
      )}
      {versions !== undefined && (
        <section aria-label="Version history" role="dialog">
          <h2>Version history</h2>
          <button onClick={() => setVersions(undefined)} type="button">
            Close history
          </button>
          {versions.map((version) => (
            <div key={version.id}>
              <p>Checkpoint v{version.number}</p>
              <time>{version.createdAt}</time>
              {editable === true && (
                <button
                  disabled={busy}
                  onClick={() => setConfirm(version.number)}
                  type="button"
                >
                  Restore v{version.number}
                </button>
              )}
            </div>
          ))}
          {editable === true && confirm !== undefined && (
            <div role="alertdialog">
              <p>Restore checkpoint v{confirm} for everyone?</p>
              <button disabled={busy} onClick={restore} type="button">
                Confirm restore
              </button>
              <button onClick={() => setConfirm(undefined)} type="button">
                Cancel restore
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
