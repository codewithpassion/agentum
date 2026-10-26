import { useRouter } from "@tanstack/react-router";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { toast } from "sonner";
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

  useEffect(() => {
    setDraft(voice);
    setError(undefined);
  }, [voice]);

  const changeDraft = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const save = useCallback(async () => {
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
  }, [agentId, draft, router]);

  const dirty = draft !== voice;

  return (
    <div className="flex flex-col gap-2">
      <Label className="sr-only" htmlFor={textareaId}>
        Voice
      </Label>
      <Textarea id={textareaId} onChange={changeDraft} rows={3} value={draft} />
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
          <Button disabled={saving} onClick={save} size="sm" variant="outline">
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
