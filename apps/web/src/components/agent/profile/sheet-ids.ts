/** The manage sheets of the profile page, as the `sheet` search param spells them. */
export const SHEET_IDS = [
  "tools",
  "skills",
  "handsTo",
  "startsOn",
  "channels",
  "edit",
] as const;

export type SheetId = (typeof SHEET_IDS)[number];

export const SHEET_TITLES: Record<SheetId, string> = {
  channels: "Channels",
  edit: "Edit agent",
  handsTo: "Hands to",
  skills: "Skills",
  startsOn: "Starts on",
  tools: "Tools",
};
