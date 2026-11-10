import type { WorkspaceMember } from "@repo/db/shared";
import { type ReactNode, useCallback, useState } from "react";
import type {
  AgentProfileView,
  AgentRecord,
  MailboxRecord,
} from "#/integrations/trpc/types";
import { AsksRow } from "./asks-row.tsx";
import { BrowserSwitch } from "./browser-switch.tsx";
import { ChipList } from "./chip-list.tsx";
import { Disclosure } from "./disclosure.tsx";
import { LibraryRow } from "./library-row.tsx";
import { MailProvisionButton } from "./mail-provision-button.tsx";
import { MailStartChip } from "./mail-start-chip.tsx";
import {
  browserChip,
  browserOn,
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
import { SubagentsSwitch } from "./subagents-switch.tsx";
import { VoiceField } from "./voice-field.tsx";
import { WorksWith } from "./works-with.tsx";

/** Characters that can overflow four lines on a 360px phone. */
const LONG_DOES = 150;

/** The instruction text, clamped to four lines. On phones a toggle shows all of it. */
function DoesText({ does }: { does: string }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  if (does === "") {
    return <p className="text-muted-foreground">No instructions yet.</p>;
  }
  return (
    <>
      <p
        className={`whitespace-pre-line max-md:[overflow-wrap:anywhere] ${expanded ? "" : "line-clamp-4"}`}
        data-testid="profile-does"
      >
        {does}
      </p>
      {does.length > LONG_DOES || does.includes("\n") ? (
        <button
          aria-expanded={expanded}
          className="mt-1 text-primary text-xs hover:underline md:hidden"
          onClick={toggle}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

/** The profile card: one row per part of the agent, each with its own manage action. */
export function ProfileRows({
  agent,
  mailbox,
  members,
  onChanged,
  onOpen,
  onOpenMail,
  peers,
  profile,
}: {
  agent: AgentRecord;
  mailbox: MailboxRecord | null;
  /** The Asks row shows when this is set. Null means the member lookup failed. */
  members?: WorkspaceMember[] | null;
  onChanged?: () => void;
  onOpen: (sheet: SheetId) => void;
  onOpenMail: () => void;
  /** The agent's connections, shown under Works with. Left out where they are not loaded. */
  peers?: ReactNode;
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
        <DoesText does={profile.does} />
      </Row>
      {members === undefined ? null : (
        <Row label="Owner">
          <AsksRow agent={agent} members={members} />
        </Row>
      )}
      <Row label="Tools">
        <ChipList
          action={{ ...open("tools"), label: "+ Add tool" }}
          chips={[
            browserChip(browserOn(agent.runtimeConfig)),
            ...toolChips(profile.tools),
          ]}
          extra={<BrowserSwitch agent={agent} onChanged={onChanged} />}
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
      <WorksWith
        handsTo={
          <ChipList
            action={{ ...open("handsTo"), label: "Manage" }}
            chips={handsToChips(profile.handsTo)}
            note={receivesFromText(profile.receivesFrom)}
          />
        }
        peers={peers}
        subagents={<SubagentsSwitch agent={agent} onChanged={onChanged} />}
      />
      <Disclosure
        className="border-border border-t border-dashed"
        summary="Voice, skills, library, channels"
        title="More"
      >
        <Row label="Voice">
          <VoiceField agentId={agent.id} voice={profile.voice} />
        </Row>
        <Row label="Skills">
          <ChipList
            action={{ ...open("skills"), label: "+ Add skill" }}
            chips={skillChips(profile.skills)}
          />
        </Row>
        <Row label="Library">
          <LibraryRow agent={agent} folders={profile.library.folders} />
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
      </Disclosure>
    </section>
  );
}
