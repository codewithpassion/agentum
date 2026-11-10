import { Archive, ArchiveRestore, Pencil, Pin, PinOff } from "lucide-react";
import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { newTitle, type ThreadMeta } from "./thread-meta.ts";

const messageOf = (cause: unknown): string => errorMessage(cause);

/** The thread's name, shown big and editable, and its pin and archive buttons. */
export function ThreadTitle({
  keyboardOpen,
  onError,
  session,
}: {
  keyboardOpen: boolean;
  onError: (message: string) => void;
  session: ThreadMeta & { id: string };
}) {
  const [meta, setMeta] = useState<ThreadMeta>(session);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { archivedAt, pinnedAt, title } = session;
  // A refetch carries what another member changed.
  useEffect(
    () => setMeta({ archivedAt, pinnedAt, title }),
    [archivedAt, pinnedAt, title]
  );

  const change = useCallback(
    async (patch: Partial<ThreadMeta>, write: () => Promise<unknown>) => {
      try {
        await write();
        setMeta((current) => ({ ...current, ...patch }));
      } catch (cause) {
        onError(messageOf(cause));
      }
    },
    [onError]
  );
  // Escape unmounts the input, and the blur that follows must not save the draft.
  const save = useCallback(
    async (event: FocusEvent<HTMLInputElement>) => {
      if (event.currentTarget.dataset.cancelled === "true") {
        return;
      }
      const name = newTitle(draft, meta.title);
      setEditing(false);
      if (name !== null) {
        await change({ title: name }, () =>
          getTrpc().sessions.rename.mutate({
            sessionId: session.id,
            title: name,
          })
        );
      }
    },
    [change, draft, meta.title, session.id]
  );
  const togglePin = useCallback(() => {
    const pinned = meta.pinnedAt === null;
    return change({ pinnedAt: pinned ? new Date().toISOString() : null }, () =>
      pinned
        ? getTrpc().sessions.pin.mutate({ sessionId: session.id })
        : getTrpc().sessions.unpin.mutate({ sessionId: session.id })
    );
  }, [change, meta.pinnedAt, session.id]);
  const toggleArchive = useCallback(() => {
    const archived = meta.archivedAt === null;
    return change(
      { archivedAt: archived ? new Date().toISOString() : null },
      () =>
        archived
          ? getTrpc().sessions.archive.mutate({ sessionId: session.id })
          : getTrpc().sessions.unarchive.mutate({ sessionId: session.id })
    );
  }, [change, meta.archivedAt, session.id]);
  const startEditing = useCallback(() => {
    setDraft(meta.title);
    setEditing(true);
  }, [meta.title]);
  const onDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const onKey = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.currentTarget.dataset.cancelled = "true";
      setEditing(false);
    }
  }, []);

  return (
    <div className="flex w-full min-w-0 items-start gap-1 md:flex-1">
      {editing ? (
        <Input
          aria-label="Thread name"
          autoFocus
          className="h-9 min-w-0 flex-1 font-heading text-lg md:text-[22px]"
          maxLength={200}
          onBlur={save}
          onChange={onDraft}
          onKeyDown={onKey}
          value={draft}
        />
      ) : (
        <h1
          className={`${keyboardOpen ? "line-clamp-1" : "line-clamp-2"} min-w-0 flex-1 font-heading text-lg leading-[1.3] md:line-clamp-2 md:text-[22px]`}
        >
          {meta.title}
        </h1>
      )}
      {editing ? null : (
        <>
          <Button
            aria-label="Rename thread"
            className="size-8 shrink-0"
            onClick={startEditing}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            aria-label={meta.pinnedAt === null ? "Pin thread" : "Unpin thread"}
            aria-pressed={meta.pinnedAt !== null}
            className="size-8 shrink-0"
            onClick={togglePin}
            size="icon"
            type="button"
            variant="ghost"
          >
            {meta.pinnedAt === null ? (
              <Pin aria-hidden="true" />
            ) : (
              <PinOff aria-hidden="true" />
            )}
          </Button>
          <Button
            aria-label={
              meta.archivedAt === null ? "Archive thread" : "Unarchive thread"
            }
            aria-pressed={meta.archivedAt !== null}
            className="size-8 shrink-0"
            onClick={toggleArchive}
            size="icon"
            type="button"
            variant="ghost"
          >
            {meta.archivedAt === null ? (
              <Archive aria-hidden="true" />
            ) : (
              <ArchiveRestore aria-hidden="true" />
            )}
          </Button>
        </>
      )}
    </div>
  );
}
