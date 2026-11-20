import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { RememberDialog, rememberDefaultText } from "./remember-message.tsx";
import { useThreadEnv } from "./thread-context.tsx";

const REMEMBERED_TOAST = "Remembered";
const OPEN_KNOWS_LABEL = "Open Knows";

function RememberMenu({
  agentId,
  sessionId,
  text,
}: {
  agentId: string;
  sessionId: string;
  text: string;
}) {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = useCallback(() => setDialogOpen(true), []);
  const onSaved = useCallback(
    () =>
      toast(REMEMBERED_TOAST, {
        action: {
          label: OPEN_KNOWS_LABEL,
          onClick: () =>
            navigate({
              params: { agentId },
              search: { tab: "knows" },
              to: "/agents/$agentId",
            }),
        },
      }),
    [agentId, navigate]
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Message actions"
            className="min-h-10 md:min-h-9"
            data-testid="message-menu"
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid="message-menu-remember"
            onSelect={openDialog}
          >
            Remember
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A sibling of the menu, so the dialog stays open after the menu closes. */}
      <RememberDialog
        agentId={agentId}
        messageText={text}
        onOpenChange={setDialogOpen}
        onSaved={onSaved}
        open={dialogOpen}
        sessionId={sessionId}
      />
    </>
  );
}

/** The per-message actions. Renders nothing unless the thread can save to memory and the message has text. */
export function MessageMenu({ text }: { text: string }) {
  const { remember } = useThreadEnv();
  if (remember === undefined || rememberDefaultText(text) === "") {
    return null;
  }
  return (
    <RememberMenu
      agentId={remember.agentId}
      sessionId={remember.sessionId}
      text={text}
    />
  );
}
