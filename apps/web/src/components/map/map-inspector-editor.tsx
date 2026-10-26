import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ManageSheet } from "#/components/agent/profile/manage-sheet.tsx";
import { ProfileRows } from "#/components/agent/profile/profile-rows.tsx";
import type { SheetId } from "#/components/agent/profile/sheet-ids.ts";
import { MailSheet } from "#/components/agent/profile/sheets/mail-sheet.tsx";
import { buttonVariants } from "#/components/ui/button.tsx";
import type {
  AgentProfileView,
  AgentRecord,
  MailboxRecord,
} from "#/integrations/trpc/types";

/** The `mail` value that shows the thread list, as the profile page spells it. */
const THREAD_LIST = "1";

/**
 * The profile page's rows and manage sheets, for the map's editor. The sheets
 * keep their open state here, not in the URL. Closing one reloads the profile.
 */
export function AgentEditor({
  agent,
  mailbox,
  onChanged,
  profile,
}: {
  agent: AgentRecord;
  mailbox: MailboxRecord | null;
  onChanged: () => void;
  profile: AgentProfileView;
}) {
  const [sheet, setSheet] = useState<SheetId | undefined>(undefined);
  const [mail, setMail] = useState<string | undefined>(undefined);

  const openMail = useCallback(() => setMail(THREAD_LIST), []);
  const closeSheet = useCallback(() => {
    setSheet(undefined);
    onChanged();
  }, [onChanged]);
  const closeMail = useCallback(() => {
    setMail(undefined);
    onChanged();
  }, [onChanged]);

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="[&>section]:flex-none [&>section]:basis-auto">
        <ProfileRows
          agent={agent}
          mailbox={mailbox}
          onOpen={setSheet}
          onOpenMail={openMail}
          profile={profile}
        />
      </div>
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        params={{ agentId: agent.id }}
        to="/agents/$agentId"
      >
        Open full profile
      </Link>
      <ManageSheet agent={agent} onClose={closeSheet} sheet={sheet} />
      <MailSheet
        agent={agent}
        mail={mail}
        onChange={setMail}
        onClose={closeMail}
      />
    </div>
  );
}
