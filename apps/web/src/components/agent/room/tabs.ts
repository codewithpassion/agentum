/** The seven tabs of the agent room, as the `tab` search param spells them. */
export const ROOM_TABS = [
  "chat",
  "work",
  "files",
  "knows",
  "keys",
  "jobs",
  "settings",
] as const;

export type RoomTab = (typeof ROOM_TABS)[number];

export const DEFAULT_TAB: RoomTab = "chat";

export const TAB_LABELS: Record<RoomTab, string> = {
  chat: "Chat",
  files: "Files",
  jobs: "Jobs",
  keys: "Keys",
  knows: "Knows",
  settings: "Settings",
  work: "Work",
};

/** The old profile sheets, each now a section of one tab. */
export const SHEET_IDS = [
  "tools",
  "skills",
  "handsTo",
  "startsOn",
  "channels",
  "edit",
] as const;

export type LegacySheet = (typeof SHEET_IDS)[number];

const SHEET_TABS: Record<LegacySheet, RoomTab> = {
  channels: "keys",
  edit: "settings",
  handsTo: "keys",
  skills: "knows",
  startsOn: "jobs",
  tools: "keys",
};

/**
 * The tab a room URL opens. `?tab=` wins. Old links keep working: `?sheet=`
 * maps through SHEET_TABS and `?mail=` opens Keys, where mail is set up.
 */
export const resolveTab = (search: {
  mail?: string | undefined;
  sheet?: LegacySheet | undefined;
  tab?: RoomTab | undefined;
}): RoomTab => {
  if (search.tab !== undefined) {
    return search.tab;
  }
  if (search.sheet !== undefined) {
    return SHEET_TABS[search.sheet];
  }
  if (search.mail !== undefined) {
    return "keys";
  }
  return DEFAULT_TAB;
};

/**
 * The search an old `?sheet=` link becomes, or null when the URL has no
 * `sheet`. The route redirects to it, so the address bar shows `?tab=`.
 */
export const legacySheetSearch = (search: {
  mail?: string | undefined;
  sheet?: LegacySheet | undefined;
  tab?: RoomTab | undefined;
}): { mail?: string; tab: RoomTab } | null => {
  if (search.sheet === undefined) {
    return null;
  }
  const tab = resolveTab(search);
  return search.mail === undefined ? { tab } : { mail: search.mail, tab };
};
