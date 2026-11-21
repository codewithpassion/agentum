import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import { SendHint } from "#/components/composer/send-hint";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { StickyComposer } from "#/components/composer/sticky-composer";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
import { canSend } from "#/components/inbox/inbox-logic";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { cn } from "#/lib/utils.ts";
import { MemberAvatar } from "./member-avatar.tsx";
import {
  activeMention,
  insertMention,
  type MentionToken,
  mentionOptions,
} from "./mention-logic.ts";
import { memberKey, type RoomMember } from "./room-types.ts";

interface MentionComposerProps {
  members: readonly RoomMember[];
  onSent: () => void;
  threadId: string;
}

const optionId = (listId: string, index: number): string =>
  `${listId}-option-${index}`;

const wrapIndex = (index: number, length: number): number =>
  (index + length) % length;

interface MentionOptionProps {
  active: boolean;
  id: string;
  member: RoomMember;
  onPick: (member: RoomMember) => void;
}

/** A row in the mention list. Mouse down picks it before the textarea loses focus. */
function MentionOption({ active, id, member, onPick }: MentionOptionProps) {
  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      onPick(member);
    },
    [member, onPick]
  );
  return (
    <div
      aria-selected={active}
      className={cn(
        "flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 text-sm",
        active && "bg-accent text-accent-foreground"
      )}
      id={id}
      onMouseDown={handleMouseDown}
      role="option"
      tabIndex={-1}
    >
      <MemberAvatar member={member} size="sm" />
      <span className="truncate">{member.name}</span>
      {member.handle === null ? null : (
        <span className="truncate text-muted-foreground">@{member.handle}</span>
      )}
    </div>
  );
}

export function MentionComposer({
  members,
  onSent,
  threadId,
}: MentionComposerProps) {
  const textId = useId();
  const hintId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [token, setToken] = useState<MentionToken | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled: sending,
    getValue: () => text,
    inputRef,
    setValue: (value) => {
      setText(value);
      setToken(null);
    },
  });
  const busy = sending || dictation.busy;

  const options = useMemo(
    () => (token === null ? [] : mentionOptions(token.query, members)),
    [token, members]
  );
  const listOpen = options.length > 0;
  const current = listOpen ? Math.min(activeIndex, options.length - 1) : 0;

  const syncToken = useCallback(
    (textarea: HTMLTextAreaElement) => {
      const next = activeMention(textarea.value, textarea.selectionStart);
      setToken(next);
      if (next?.query !== token?.query) {
        setActiveIndex(0);
      }
    },
    [token]
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setText(event.target.value);
      syncToken(event.target);
    },
    [syncToken]
  );

  const handleSelect = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) =>
      syncToken(event.currentTarget),
    [syncToken]
  );

  // Escape closes the list. Its keyup must not reopen it.
  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Escape") {
        syncToken(event.currentTarget);
      }
    },
    [syncToken]
  );

  const pick = useCallback(
    (member: RoomMember) => {
      if (token === null || member.handle === null) {
        return;
      }
      const next = insertMention(text, token, member.handle);
      setText(next.text);
      setToken(null);
      setPendingCaret(next.caret);
    },
    [text, token]
  );

  useEffect(() => {
    if (pendingCaret === null) {
      return;
    }
    inputRef.current?.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!listOpen) {
        submitOnSendShortcut(event);
        return;
      }
      if (event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex(wrapIndex(current + step, options.length));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setToken(null);
        return;
      }
      const picksOption =
        (event.key === "Enter" || event.key === "Tab") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey;
      if (picksOption) {
        event.preventDefault();
        const member = options[current];
        if (member !== undefined) {
          pick(member);
        }
        return;
      }
      submitOnSendShortcut(event);
    },
    [current, listOpen, options, pick]
  );

  const handleBlur = useCallback(() => setToken(null), []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSend(text, busy)) {
        return;
      }
      setSending(true);
      setError(null);
      try {
        await getTrpc().inbox.post.mutate({ text: text.trim(), threadId });
        setText("");
        setToken(null);
        onSent();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSending(false);
      }
    },
    [text, busy, threadId, onSent]
  );

  return (
    <StickyComposer background="bg-background">
      <form
        className="flex flex-col gap-2 md:border-t md:pt-4"
        onSubmit={handleSubmit}
      >
        <Label htmlFor={textId}>Message</Label>
        <div className="relative">
          {listOpen ? (
            <div
              aria-label="Mention suggestions"
              className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-60 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
              id={listId}
              role="listbox"
            >
              {options.map((member, index) => (
                <MentionOption
                  active={index === current}
                  id={optionId(listId, index)}
                  key={memberKey(member.kind, member.id)}
                  member={member}
                  onPick={pick}
                />
              ))}
            </div>
          ) : null}
          <Textarea
            aria-activedescendant={
              listOpen ? optionId(listId, current) : undefined
            }
            aria-autocomplete="list"
            aria-controls={listOpen ? listId : undefined}
            aria-describedby={hintId}
            aria-expanded={listOpen}
            id={textId}
            onBlur={handleBlur}
            onChange={handleChange}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onSelect={handleSelect}
            readOnly={dictation.busy}
            ref={inputRef}
            role="combobox"
            value={text}
          />
          <DictationPreview dictation={dictation} />
        </div>
        <p className="text-muted-foreground text-xs" id={hintId}>
          Type @ to mention an agent or a teammate. An agent you mention starts
          a task.
        </p>
        <div className="flex items-center gap-2">
          <Button disabled={!canSend(text, busy)} type="submit">
            Send
          </Button>
          <div className="max-md:[&_button]:size-11">
            <DictationButton dictation={dictation} />
          </div>
          <SendHint />
        </div>
        {error === null ? null : (
          <p className="text-destructive text-sm">{error}</p>
        )}
      </form>
    </StickyComposer>
  );
}
