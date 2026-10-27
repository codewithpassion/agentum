/** biome-ignore-all lint/performance/noJsxPropsBind: Guest page wires artifact-scoped ports. */
import type { GuestOpenResult } from "@repo/protocol/guest";
import { guestEndpoints } from "@repo/protocol/guest";
import type { CommentAnchor } from "@repo/protocol/live";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DocumentEditor } from "../live-artifacts/document-editor";
import type { EditorRole } from "../live-artifacts/editor-ports";
import { TicketedRoom } from "../live-artifacts/room-provider";
import { TicketedDeckRoom } from "../live-decks/room-provider";
import { DeckRuntimeGate } from "../live-decks/runtime-gate";
import { TooltipProvider } from "../ui/tooltip";
import { GuestComments } from "./comments";
import { guestHttp } from "./http";
import { guestServices } from "./services";
import { GuestTranscript } from "./transcript";
export function GuestViewer({ artifactId }: { artifactId: string }) {
  const services = useMemo(() => guestServices(artifactId), [artifactId]);
  const [invitations, setInvitations] = useState<
    Array<{ artifactId: string; title: string }>
  >([]);
  const [opened, setOpened] = useState<GuestOpenResult>();
  const [room, setRoom] = useState<TicketedRoom | TicketedDeckRoom>();
  const [role, setRole] = useState<EditorRole>("viewer");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [anchor, setAnchor] = useState<CommentAnchor>();
  const [, render] = useState(0);
  const failed = useCallback(
    (message: string) => {
      setError(
        message === "This invite has ended"
          ? "Action unavailable. Reconnect to refresh access."
          : message
      );
      const verify = async () => {
        try {
          await guestHttp.json(services.endpoint("rotate"), {});
        } catch (cause) {
          if (
            cause instanceof Error &&
            cause.message === "This invite has ended"
          ) {
            setEnded(true);
          }
        }
      };
      verify();
    },
    [services]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt recreates the room after its queued rotations finish.
  useEffect(() => {
    setRoom(undefined);
    setError("");
    let disposed = false;
    let provider: TicketedRoom | TicketedDeckRoom | undefined;
    let release: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    guestHttp
      .json<GuestOpenResult>(services.endpoint("open"))
      .then((result) => {
        if (disposed) {
          return;
        }
        setOpened(result);
        let initialJoin = true;
        const options = {
          admitted: () => release?.(),
          failed: (message: string) => {
            release?.();
            setRoom(undefined);
            failed(message);
          },
          join: () => {
            if (!initialJoin) {
              return guestHttp.json<
                import("@repo/protocol/live").LiveJoinResult
              >(services.endpoint("join"), {});
            }
            initialJoin = false;
            const handshake = services.join();
            release = handshake.admitted;
            return handshake.joined;
          },
          policy: services.policy,
          roleChanged: setRole,
        };
        provider =
          result.kind === "document"
            ? new TicketedRoom({
                ...options,
                ready: setRoom,
              })
            : new TicketedDeckRoom({ ...options, ready: setRoom });
        if (provider instanceof TicketedDeckRoom) {
          unsubscribe = provider.subscribe(() => render((old) => old + 1));
        }
        provider.connect();
      })
      .catch((cause: Error) => failed(cause.message));
    return () => {
      disposed = true;
      release?.();
      unsubscribe?.();
      provider?.dispose();
      services.dispose();
      setTimeout(() => {
        if (provider instanceof TicketedDeckRoom) {
          provider.deck.destroy();
        }
        provider?.document.destroy();
      }, 0);
    };
  }, [services, failed, attempt]);
  useEffect(() => {
    if (room === undefined) {
      return;
    }
    guestHttp
      .json<Array<{ artifactId: string; title: string }>>(
        services.endpoint("invitations")
      )
      .then(setInvitations)
      .catch((cause: Error) => failed(cause.message));
  }, [room, services, failed]);
  useEffect(() => {
    if (ended || signedOut) {
      room?.dispose();
      services.dispose();
    }
  }, [ended, signedOut, room, services]);
  if (signedOut) {
    return (
      <main className="guest-landing">
        <h1>Signed out</h1>
        <p>Open your invitation to sign in again.</p>
      </main>
    );
  }
  if (ended) {
    return (
      <main className="guest-landing">
        <h1>This invite has ended</h1>
        <p>
          Contact {opened?.inviterName ?? "the person who invited you"} for
          access.
        </p>
      </main>
    );
  }
  return (
    <TooltipProvider>
      <header className="guest-bar">
        <p>
          {opened
            ? `Shared with you by ${opened.inviterName} from ${opened.workspaceName}`
            : "Opening shared artifact…"}
          <br />
          Your visits are logged.
        </p>
        <span>{role}</span>
        {invitations.length > 1 && (
          <nav aria-label="Shared with you">
            {invitations.map((invitation) => (
              <a
                href={`/g/a/${encodeURIComponent(invitation.artifactId)}`}
                key={invitation.artifactId}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  window.history.pushState(null, "", event.currentTarget.href);
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
              >
                {invitation.title}
              </a>
            ))}
          </nav>
        )}
        <button
          onClick={async () => {
            try {
              await guestHttp.json(guestEndpoints.signout, {});
              room?.dispose();
              setSignedOut(true);
            } catch (cause) {
              failed(
                cause instanceof Error ? cause.message : "Sign out failed"
              );
            }
          }}
          type="button"
        >
          Sign out
        </button>
      </header>
      <main className="guest-content">
        <h1>{opened?.title}</h1>
        {Boolean(error) && (
          <div role="alert">
            <p>{error}</p>
            <button onClick={() => setAttempt((old) => old + 1)} type="button">
              Reconnect
            </button>
          </div>
        )}
        {!(room || error) && <p role="status">Connecting to shared content…</p>}
        {room instanceof TicketedRoom ? (
          <DocumentEditor
            document={room.document}
            imageUrl={services.imageUrl}
            onCommentSelection={(selection) => {
              room.select(selection.start, selection.end);
              setAnchor({
                detached: false,
                end: selection.end,
                kind: "document",
                start: selection.start,
              });
            }}
            policy={room.policy}
            provider={room.presence}
            role={role}
            uploadImage={services.upload}
          />
        ) : null}
        {room instanceof TicketedDeckRoom ? (
          <DeckRuntimeGate
            runtime={{
              ports: {
                comment: (where) => {
                  setAnchor({
                    detached: false,
                    elementId: where.elementIds[0],
                    kind: "deck",
                    slideId: where.slideId,
                  });
                  return Promise.resolve();
                },
                deck: room.deck,
                ensureCell: async (slideId, elementId, key) => {
                  const result = await guestHttp.json<{ state: number[] }>(
                    services.endpoint("ensure-deck-cell"),
                    { elementId, key, slideId }
                  );
                  await room.applyAuthority(result.state);
                },
                imageUrl: services.imageUrl,
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
                upload: async (file) => {
                  const result = await services.upload(file);
                  await room.refreshOwnership();
                  return { path: result.url };
                },
              },
              state: "ready",
            }}
          />
        ) : null}
        {room !== undefined && (
          <GuestTranscript failed={failed} services={services} />
        )}
        {room !== undefined && (
          <GuestComments
            anchor={anchor}
            failed={failed}
            role={role}
            services={services}
          />
        )}
      </main>
    </TooltipProvider>
  );
}
