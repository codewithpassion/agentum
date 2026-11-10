import type { RouterOutputs } from "#/integrations/trpc/types";

export type AskBeforeAction =
  RouterOutputs["agentProfile"]["askBefore"][number];

export interface AskGroup {
  actions: AskBeforeAction[];
  askCount: number;
  /** The distinct "Also ..." lines of the group, each once. */
  covers: string[];
  name: string;
}

/** The actions by source, in the order each source first appears. */
export function groupActions(actions: readonly AskBeforeAction[]): AskGroup[] {
  const groups = new Map<string, AskBeforeAction[]>();
  for (const action of actions) {
    groups.set(action.group, [...(groups.get(action.group) ?? []), action]);
  }
  return [...groups].map(([name, members]) => ({
    actions: members,
    askCount: members.filter((member) => member.ask).length,
    covers: [
      ...new Set(
        members.flatMap((member) =>
          member.covers === undefined ? [] : [member.covers]
        )
      ),
    ],
    name,
  }));
}

/** "2 of 5 ask". */
export function askSummary(
  group: Pick<AskGroup, "actions" | "askCount">
): string {
  return `${group.askCount} of ${group.actions.length} ask`;
}

export const ASK_LEVEL_OPTIONS = [
  {
    description: "Only before it sends a message to a person.",
    label: "Ask rarely",
    value: "rarely",
  },
  {
    description: "Also before it uses a connector tool or fetches a web page.",
    label: "Ask before it acts outside",
    value: "outside",
  },
  {
    description: "Before every action in the list, new tools included.",
    label: "Ask before everything",
    value: "everything",
  },
] as const;

export type AskLevelValue = (typeof ASK_LEVEL_OPTIONS)[number]["value"];

export function isPresetLevel(level: string): level is AskLevelValue {
  return ASK_LEVEL_OPTIONS.some((option) => option.value === level);
}
