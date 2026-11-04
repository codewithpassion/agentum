import { useRouter } from "@tanstack/react-router";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";

interface VoiceFieldProps {
  agentId: string;
  voice: string;
}

export function VoiceField({ agentId, voice }: VoiceFieldProps) {
  const router = useRouter();
  const textareaId = useId();
  const [draft, setDraft] = useState(voice);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled: saving,
    getValue: () => draft,
    inputRef,
    setValue: setDraft,
  });
  useEffect(() => {
    setDraft(voice);
    setError(undefined);
  }, [voice]);

  const changeDraft = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const save = useCallback(async () => {
    if (saving || dictation.busy) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await getTrpc().agents.update.mutate({
        id: agentId,
        patch: { soul: draft },
      });
      await router.invalidate();
      toast.success("Saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [agentId, draft, router, saving, dictation.busy]);

  const dirty = draft !== voice;

  return (
    <div className="flex flex-col gap-2">
      <Label className="sr-only" htmlFor={textareaId}>
        Voice
      </Label>
      <div className="relative">
        <Textarea
          id={textareaId}
          onChange={changeDraft}
          readOnly={dictation.busy}
          ref={inputRef}
          rows={3}
          value={draft}
        />
        <DictationPreview dictation={dictation} />
      </div>
      <DictationButton dictation={dictation} />
      {draft.trim() === "" ? (
        <p className="text-muted-foreground text-sm">
          How it speaks and what it never does.
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      {dirty ? (
        <div>
          <Button
            disabled={saving || dictation.busy}
            onClick={save}
            size="sm"
            variant="outline"
          >
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
