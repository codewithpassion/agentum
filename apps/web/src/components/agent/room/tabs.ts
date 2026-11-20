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
  mail?: number | string | undefined;
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

/** The `mail` value that shows the mailbox thread list. */
export const MAIL_LIST = "1";

/**
 * The value to put in the URL for `?mail=`. The router writes a string that
 * looks like a number as JSON (`%221%22`), so the list marker goes in as the
 * number 1 and reads `mail=1`. The route turns it back into text.
 */
export const mailParam = (
  mail: number | string | undefined
): number | string | undefined =>
  mail === MAIL_LIST ? Number(MAIL_LIST) : mail;

/**
 * The search an old link becomes, or null when the URL is already in the new
 * form. A `?sheet=` or a `?mail=` with no `?tab=` redirects to it, so the
 * address bar shows `?tab=`.
 */
export const legacyRedirectSearch = (search: {
  mail?: number | string | undefined;
  sheet?: LegacySheet | undefined;
  tab?: RoomTab | undefined;
}): { mail?: number | string; tab: RoomTab } | null => {
  if (
    search.sheet === undefined &&
    (search.mail === undefined || search.tab !== undefined)
  ) {
    return null;
  }
  const tab = resolveTab(search);
  const mail = mailParam(search.mail);
  return mail === undefined ? { tab } : { mail, tab };
};
