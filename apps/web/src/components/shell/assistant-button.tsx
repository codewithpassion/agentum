import { Sparkles } from "lucide-react";
import { useCallback } from "react";
import { useAssistantLocation } from "#/components/assistant/assistant-location";
import { Button } from "#/components/ui/button";

/** Opens the assistant panel, or closes it when a conversation is open. */
export function AssistantButton({ onToggle }: { onToggle?: () => void }) {
  const { conversationId, open } = useAssistantLocation();
  const toggle = useCallback(() => {
    onToggle?.();
    open(conversationId ? null : "new");
  }, [conversationId, onToggle, open]);
  return (
    <Button
      aria-label="Assistant"
      aria-pressed={conversationId !== null}
      onClick={toggle}
      type="button"
      variant="outline"
    >
      <Sparkles />
      Assistant
    </Button>
  );
}
