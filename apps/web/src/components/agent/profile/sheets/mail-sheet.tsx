import { type ReactNode, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import type { AgentRecord } from "#/integrations/trpc/types";
import { MailList } from "./mail-list.tsx";
import { MailThreadPanel } from "./mail-thread.tsx";

/** The `mail` search param value that shows the thread list. */
const THREAD_LIST = "1";

function SheetBody({
  agentId,
  back,
  mail,
  onOpen,
}: {
  agentId: string;
  back: () => void;
  mail: string;
  onOpen: (threadId: string) => void;
}) {
  if (mail === THREAD_LIST) {
    return <MailList agentId={agentId} onOpen={onOpen} />;
  }
  return <MailThreadPanel onBack={back} threadId={mail} />;
}

/** The side sheet for mail. `mail` is undefined while it is closed, "1" for the thread list, else a thread id. */
export function MailSheet({
  agent,
  mail,
  onChange,
  onClose,
}: {
  agent: AgentRecord;
  mail: string | undefined;
  onChange: (next: string | undefined) => void;
  onClose: () => void;
}): ReactNode {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  const back = useCallback(() => onChange(THREAD_LIST), [onChange]);
  return (
    <Sheet onOpenChange={handleOpenChange} open={mail !== undefined}>
      <SheetContent className="data-[side=right]:sm:max-w-3xl" side="right">
        <SheetHeader>
          <SheetTitle>Mail</SheetTitle>
          <SheetDescription>{agent.name}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {mail === undefined ? null : (
            <SheetBody
              agentId={agent.id}
              back={back}
              mail={mail}
              onOpen={onChange}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
