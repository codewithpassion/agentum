import type { ReactNode } from "react";
import { ChatTab } from "./chat/index.tsx";
import { FilesTab } from "./files/index.tsx";
import { JobsTab } from "./jobs/index.tsx";
import { KeysTab } from "./keys/index.tsx";
import { KnowsTab } from "./knows/index.tsx";
import type { RoomTabProps } from "./room-data.ts";
import { RoomHeader } from "./room-header.tsx";
import { SettingsTab } from "./settings/index.tsx";
import { panelId, TabBar, tabId } from "./tab-bar.tsx";
import type { RoomTab } from "./tabs.ts";
import { WorkTab } from "./work/index.tsx";

const TABS: Record<RoomTab, (props: RoomTabProps) => ReactNode> = {
  chat: ChatTab,
  files: FilesTab,
  jobs: JobsTab,
  keys: KeysTab,
  knows: KnowsTab,
  settings: SettingsTab,
  work: WorkTab,
};

/** Disables every control inside it, for an archived agent. */
function Disabled({ children, when }: { children: ReactNode; when: boolean }) {
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
      disabled={when}
    >
      {children}
    </fieldset>
  );
}

/**
 * The header, the tab bar and the open tab. An archived agent's header and
 * tab are disabled, but the bar is not, so its tabs still switch.
 */
export function RoomFrame({
  nowMs,
  onEdit,
  onOpenMail,
  onOpenTab,
  onStarted,
  room,
  tab,
}: Pick<RoomTabProps, "nowMs" | "onOpenTab" | "room"> & {
  onEdit: () => void;
  onOpenMail: () => void;
  onStarted: (runId: string) => void;
  tab: RoomTab;
}) {
  const archived = room.agent.status === "archived";
  const Body = TABS[tab];
  return (
    <>
      <Disabled when={archived}>
        <RoomHeader
          onEdit={onEdit}
          onOpenMail={onOpenMail}
          onStarted={onStarted}
          room={room}
        />
      </Disabled>
      <TabBar onSelect={onOpenTab} selected={tab} />
      <Disabled when={archived}>
        <div aria-labelledby={tabId(tab)} id={panelId(tab)} role="tabpanel">
          <Body nowMs={nowMs} onOpenTab={onOpenTab} room={room} />
        </div>
      </Disabled>
    </>
  );
}
