import { useCallback } from "react";
import type {
  AgentProfileView,
  AgentRecord,
  MailboxRecord,
} from "#/integrations/trpc/types";
import { ChipList } from "./chip-list.tsx";
import { LibraryRow } from "./library-row.tsx";
import { MailProvisionButton } from "./mail-provision-button.tsx";
import { MailStartChip } from "./mail-start-chip.tsx";
import {
  channelChips,
  handsToChips,
  mailProvisionLabel,
  receivesFromText,
  skillChips,
  startChips,
  toolChips,
} from "./profile-logic.ts";
import { Row } from "./profile-row.tsx";
import type { SheetId } from "./sheet-ids.ts";
import { VoiceField } from "./voice-field.tsx";

/** The profile card: one row per part of the agent, each with its own manage action. */
export function ProfileRows({
  agent,
  mailbox,
  onOpen,
  onOpenMail,
  profile,
}: {
  agent: AgentRecord;
  mailbox: MailboxRecord | null;
  onOpen: (sheet: SheetId) => void;
  onOpenMail: () => void;
  profile: AgentProfileView;
}) {
  const open = (sheet: SheetId) => ({
    label: "",
    onClick: () => onOpen(sheet),
  });
  const handleChipClick = useCallback(
    (key: string) => {
      if (key === "email") {
        onOpenMail();
      }
    },
    [onOpenMail]
  );
  const setUpLabel = mailProvisionLabel(
    profile.header.status,
    profile.header.emailLocal,
    mailbox?.status ?? null
  );
  const mailPaused = mailbox !== null && mailbox.triggerDisabledAt !== null;
  return (
    <section
      aria-label="Profile"
      className="min-w-0 flex-[999_1_520px] rounded-lg border border-border bg-card px-4 py-2"
    >
      <Row label="Does">
        <p className="line-clamp-4 whitespace-pre-line">
          {profile.does === "" ? (
            <span className="text-muted-foreground">No instructions yet.</span>
          ) : (
            profile.does
          )}
        </p>
      </Row>
      <Row label="Voice">
        <VoiceField agentId={agent.id} voice={profile.voice} />
      </Row>
      <Row label="Tools">
        <ChipList
          action={{ ...open("tools"), label: "+ Add tool" }}
          chips={toolChips(profile.tools)}
        />
      </Row>
      <Row label="Skills">
        <ChipList
          action={{ ...open("skills"), label: "+ Add skill" }}
          chips={skillChips(profile.skills)}
        />
      </Row>
      <Row label="Hands to">
        <ChipList
          action={{ ...open("handsTo"), label: "Manage" }}
          chips={handsToChips(profile.handsTo)}
          note={receivesFromText(profile.receivesFrom)}
        />
      </Row>
      <Row label="Starts on">
        <ChipList
          action={{ ...open("startsOn"), label: "+" }}
          chips={startChips(profile.startsOn)}
          extra={
            mailbox === null || mailbox.status === "disabled" ? null : (
              <MailStartChip
                address={mailbox.address}
                agentId={agent.id}
                key={mailPaused ? "paused" : "running"}
                paused={mailPaused}
              />
            )
          }
        />
      </Row>
      <Row label="Channels">
        <ChipList
          action={{ ...open("channels"), label: "Manage" }}
          chips={channelChips(
            profile.channels,
            profile.header.emailLocal,
            mailbox?.status ?? null
          )}
          extra={
            mailbox === null && setUpLabel !== null ? (
              <MailProvisionButton agentId={agent.id} label={setUpLabel} />
            ) : null
          }
          onChipClick={handleChipClick}
        />
      </Row>
      <Row label="Library">
        <LibraryRow agent={agent} folders={profile.library.folders} />
      </Row>
    </section>
  );
}
