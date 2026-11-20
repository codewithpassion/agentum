import { SkillsPanel } from "#/components/agent/profile/sheets/skills.tsx";
import { VoiceField } from "#/components/agent/profile/voice-field.tsx";
import type { RoomData } from "../room-data.ts";
import { Manage, RoomSection } from "../section.tsx";
import { DoesText } from "./does-text.tsx";
import { learnedThisWeek } from "./learned-logic.ts";
import { LearnedList } from "./learned-this-week.tsx";
import { groupNotes } from "./notes-logic.ts";
import { NotesSection } from "./notes-section.tsx";
import { RulesPanel } from "./rules-panel.tsx";
import type { MemoryApi, MemoryData } from "./use-memory.ts";

/** Marks where the dream card goes. DR.6 fills it. */
function DreamSlot() {
  return <div className="col-span-full empty:hidden" data-slot="dream-card" />;
}

function Notes({
  archived,
  data,
  memory,
}: {
  archived: boolean;
  data: MemoryData | undefined;
  memory: MemoryApi;
}) {
  if (data === undefined) {
    return memory.error === undefined ? (
      <p className="text-muted-foreground text-sm">Loading what it knows.</p>
    ) : null;
  }
  return (
    <NotesSection
      adding={memory.adding}
      busyId={memory.busyId}
      disabled={archived}
      groups={groupNotes(data.notes, data.held)}
      onAdd={memory.add}
      onDecide={memory.decide}
      onEdit={memory.edit}
      onForget={memory.forget}
    />
  );
}

/**
 * The Knows tab's page, from data that is already loaded. Left: what the
 * agent remembers, then its skills and instructions. Right: the rules the
 * owner sets and what it learned this week.
 */
export function KnowsLayout({
  canChange,
  memory,
  room,
}: {
  /** Whether this person may change the rules: the owner or an admin. */
  canChange: boolean;
  memory: MemoryApi;
  room: RoomData;
}) {
  const archived = room.agent.status === "archived";
  const { data } = memory;
  const learned =
    data === undefined
      ? []
      : learnedThisWeek(data.changes, data.nowMs, data.rules.agent.learnLevel);
  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <DreamSlot />
      {/* On a desktop each column is a stack. On a phone the columns dissolve and `order` interleaves the sections. */}
      <div className="flex min-w-0 flex-col gap-8 max-lg:contents">
        <div className="max-lg:order-1">
          <RoomSection title={`What ${room.agent.name} remembers`}>
            {memory.error === undefined ? null : (
              <p className="text-destructive text-sm" role="alert">
                {memory.error}
              </p>
            )}
            <Notes archived={archived} data={data} memory={memory} />
          </RoomSection>
        </div>
        <div className="max-lg:order-4">
          <RoomSection title="Skills">
            <Manage archived={archived}>
              <SkillsPanel agent={room.agent} />
            </Manage>
          </RoomSection>
        </div>
        <div className="max-lg:order-5">
          <RoomSection title="Instructions">
            <DoesText does={room.profile.does} full={archived} />
          </RoomSection>
        </div>
        <div className="max-lg:order-6">
          <RoomSection title="Voice">
            <VoiceField agentId={room.agent.id} voice={room.profile.voice} />
          </RoomSection>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-8 max-lg:contents">
        {data === undefined ? null : (
          <div className="max-lg:order-2">
            <RoomSection title="Remember rules">
              <RulesPanel
                canChange={canChange && !archived}
                onChange={memory.setRules}
                rules={data.rules}
                saving={memory.saving}
              />
            </RoomSection>
          </div>
        )}
        {learned.length === 0 || data === undefined ? null : (
          <div className="max-lg:order-3">
            <RoomSection title="Learned this week">
              <LearnedList
                busyId={memory.busyId}
                changes={learned}
                disabled={archived}
                nowMs={data.nowMs}
                onUndo={memory.undo}
              />
            </RoomSection>
          </div>
        )}
      </div>
    </div>
  );
}
