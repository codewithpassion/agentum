/** biome-ignore-all lint/performance/noJsxPropsBind: Actual-room fixture actions capture current connection. */
import { type LiveJoinResult, liveRoleSchema } from "@repo/protocol/live";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { encodeStateAsUpdate } from "yjs";
import { z } from "zod";
import { TicketedDeckRoom } from "../../room-provider";
import { DeckRuntimeGate } from "../../runtime-gate";
import "../../../../styles.css";

const query = new URLSearchParams(window.location.search);
const participant = query.get("participant") ?? "alice";
const roomName = query.get("room") ?? "desktop";
async function call(path: string, input: object = {}): Promise<unknown> {
  const response = await fetch(`${path}?room=${encodeURIComponent(roomName)}`, {
    body: JSON.stringify(input),
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Fixture ${path}: ${response.status}`);
  }
  return response.json();
}
function NetworkDeck() {
  const [room, setRoom] = useState<TicketedDeckRoom>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt creates a clean room replica.
  useEffect(() => {
    setRoom(undefined);
    setError(undefined);
    const provider = new TicketedDeckRoom({
      failed: (message) => {
        setError(message);
        setRoom(undefined);
      },
      join: async (): Promise<LiveJoinResult> => {
        const stats = z
          .object({ fixture: z.record(z.string(), z.unknown()) })
          .parse(await call("/stats"));
        const role = liveRoleSchema.parse(
          stats.fixture[`role:${participant}`] ?? "owner"
        );
        return {
          participant: {
            color: "#123456",
            id: participant,
            kind: "member",
            name: `Trusted ${participant}`,
          },
          role,
          roomUrl: `/socket?room=${encodeURIComponent(roomName)}`,
          ticket: z
            .string()
            .parse(await call("/ticket", { participantId: participant, role })),
        };
      },
      policy: async () => {
        const stats = z
          .object({ fixture: z.record(z.string(), z.unknown()) })
          .parse(await call("/stats"));
        return new Set(z.array(z.string()).parse(stats.fixture.urls ?? []));
      },
      ready: (connected) => {
        Reflect.set(window, "deckRoom", connected);
        Reflect.set(window, "deckDump", () => ({
          migrations: Object.fromEntries(
            [...connected.document.share]
              .filter(([name]) =>
                name.startsWith("__tiptap_position_migrations:")
              )
              .map(([name, value]) => [name, value.toJSON()])
          ),
          state: [...encodeStateAsUpdate(connected.document)],
        }));
        setRoom(connected);
      },
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
  }, [attempt]);
  return (
    <main data-revision={revision}>
      <button onClick={() => setAttempt((old) => old + 1)} type="button">
        Reconnect fixture
      </button>
      {Boolean(error) && <p role="alert">{error}</p>}
      <DeckRuntimeGate
        runtime={
          room
            ? {
                ports: {
                  ask: () =>
                    Promise.reject(
                      new Error("Agent asks require authenticated app service")
                    ),
                  comment: () =>
                    Promise.reject(
                      new Error("Comments require authenticated app service")
                    ),
                  deck: room.deck,
                  ensureCell: async (slideId, elementId, key) => {
                    const result = z
                      .object({ state: z.array(z.number()) })
                      .parse(
                        await call("/ensure-deck-cell", {
                          elementId,
                          key,
                          participantId: participant,
                          slideId,
                        })
                      );
                    await room.applyAuthority(result.state);
                  },
                  history: async () => {
                    await call("/checkpoint");
                  },
                  ownsBlob: (path) => room.policy.ownBlobUrls.has(path),
                  participants: room.participants,
                  presentation: room.presentation,
                  presentToEveryone: room.presentToEveryone,
                  provider: {
                    publishPresence: room.publishPresence,
                    state: "synced",
                  },
                  role: room.role,
                  selfId: room.selfId,
                  upload: () =>
                    Promise.reject(
                      new Error("Upload requires the authenticated app service")
                    ),
                },
                state: "ready",
              }
            : { state: "loading" }
        }
      />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root");
}
createRoot(root).render(<NetworkDeck />);
