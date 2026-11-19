import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import {
  AGENT_AVATAR_COLORS,
  type AgentAvatar,
  type AgentCard,
  defaultAgentAvatar,
} from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { readableWorkspace } from "./guards.ts";
import type { Principal } from "./workspaces.ts";

const ROSTER_READ = "roster.read";
const ROSTER_KIND = "roster";
const JOB_LINE_MAX_CHARS = 140;

type AgentRow = typeof agents.$inferSelect;

const storedAvatarSchema = z.object({
  color: z.enum(AGENT_AVATAR_COLORS),
  glyph: z.string().min(1),
});

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const avatarFor = (row: AgentRow): AgentAvatar => {
  const parsed = storedAvatarSchema.safeParse(parseJson(row.avatar));
  return parsed.success ? parsed.data : defaultAgentAvatar(row.name);
};

const jobLineFor = (soul: string): string => {
  const firstLine =
    soul
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return Array.from(firstLine).slice(0, JOB_LINE_MAX_CHARS).join("");
};

/**
 * Stub: every card reads as idle with no spend, counts or owner. RH.2 computes
 * the state, the status line, the counts and the owner name.
 */
const toAgentCard = (row: AgentRow): AgentCard => ({
  avatar: avatarFor(row),
  costThisWeekCents: 0,
  id: row.id,
  isLead: false,
  jobLine: jobLineFor(row.soul),
  learnedCount: 0,
  name: row.name,
  needsYouCount: 0,
  ownerName: "",
  slug: row.slug,
  state: "idle",
  statusLine: "Idle",
  teamId: null,
  weeklyCapCents: null,
});

export const createRosterService = ({ db }: { db: Database }) => {
  const list = async (principal: Principal): Promise<AgentCard[]> => {
    const workspaceId = readableWorkspace(principal, ROSTER_READ);
    authorize(principal, ROSTER_READ, { kind: ROSTER_KIND, workspaceId });
    const rows = await db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId), eq(agents.status, "active"))
      )
      .orderBy(asc(agents.name), asc(agents.id));
    return rows.map(toAgentCard);
  };

  return { list };
};

export type RosterService = ReturnType<typeof createRosterService>;
