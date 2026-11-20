import type { AgentKeys, WorkspaceMember } from "@repo/db/shared";
import type {
  AgentProfileView,
  AgentRecord,
  MachineRecord,
  MailboxRecord,
  MailToolRule,
  RouterOutputs,
  SessionListItem,
} from "#/integrations/trpc/types";
import type { RoomTab } from "./tabs.ts";

/** What the agent has spent this week and its weekly limit. */
export interface RoomSpend {
  /** The weekly limit in cents, or null for none. */
  capCents: number | null;
  /** True while the agent is stopped at a weekly limit. */
  paused: boolean;
  /** Cents spent this week. Null when the read failed. */
  weekCents: number | null;
}

/** Everything the room route loads. Each tab reads the parts it needs. */
export interface RoomData {
  agent: AgentRecord;
  askBefore: RouterOutputs["agentProfile"]["askBefore"];
  askLevel: RouterOutputs["agentProfile"]["askLevel"];
  connections: RouterOutputs["a2a"]["list"];
  /** What the Keys tab shows. Null when the read failed, for instance on a draft. */
  keys: AgentKeys | null;
  machines: MachineRecord[];
  mailbox: MailboxRecord | null;
  /** Null when the member lookup failed. */
  members: WorkspaceMember[] | null;
  profile: AgentProfileView;
  published: RouterOutputs["a2a"]["published"] | null;
  rules: MailToolRule[];
  spend: RoomSpend;
  tasks: RouterOutputs["tasks"]["list"];
  threads: SessionListItem[];
}

/** What the route hands every tab. A tab imports nothing from another tab's folder. */
export interface RoomTabProps {
  /** The current time, null until the page has mounted. */
  nowMs: number | null;
  /** Opens a tab, replacing the search. */
  onOpenTab: (tab: RoomTab) => void;
  room: RoomData;
}
