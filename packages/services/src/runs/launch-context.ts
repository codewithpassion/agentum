import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { type AgentRecord, handsToNames } from "../agents.ts";
import type { McpServerConnector } from "../connectors/mcp-servers.ts";
import { loadPrivateNotesUser } from "../library/private-notes.ts";
import {
  loadPromptMemory,
  type MemoryFileReader,
  type PromptMemory,
} from "../memory/prompt.ts";
import {
  loadTeamPromptNotes,
  type PromptTeam,
  type TeamMemoryReader,
  type TeamPromptNotes,
} from "../memory/team.ts";
import { slackGuidanceFor } from "../slack/guidance.ts";
import { leadRoomOf } from "../teams/room-run.ts";
import { effectiveRunScope, modelOfRun, scopeAllows } from "./access-scope.ts";
import { sessionSupportsSpeakers } from "./speakers.ts";
import type { RunAccessScope, RunRecord } from "./types.ts";

/**
 * What every runtime needs to start a run, read once: the cloud runner, the
 * machine claim and the managed session each map it to their own shape.
 */
export interface LaunchContext {
  /** The agent's connectors the run may reach, in a stable order. A lead's team-room run has none. */
  connectors: McpServerConnector[];
  /** Names of the agents it can hand off to. */
  handoffNames: string[];
  /** Notes and rules for the prompt, null when the caller gave no way to read memory. */
  memory: PromptMemory | null;
  /** The model the run asks for. */
  model: string;
  /** The session has more than one speaker. */
  multiPerson: boolean;
  /** The run's effective access scope, null when unrestricted. */
  scope: RunAccessScope | null;
  /** The Slack paragraph for the agent's instructions, empty when none. */
  slack: string;
  /** The run is a lead's run in its team room: every runtime leaves it no shell, file-writing or web tool. */
  teamRoom: boolean;
}

/** The live teams with a library folder that the run's agent is a member of, home team first, then by name. */
const teamsOfAgent = async (
  db: Database,
  run: RunRecord
): Promise<PromptTeam[]> => {
  const rows = await db
    .select({ folderPath: teams.folderPath, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        eq(teamMembers.memberKind, "agent"),
        eq(teamMembers.memberId, run.agentId),
        eq(teamMembers.workspaceId, run.workspaceId),
        eq(teams.workspaceId, run.workspaceId),
        isNull(teams.archivedAt)
      )
    )
    .orderBy(desc(teamMembers.isHome), asc(teams.name));
  return rows.flatMap((row) =>
    row.folderPath === null
      ? []
      : [{ folderPath: row.folderPath, name: row.name }]
  );
};

/** The notes of the agent's teams that fit the team budget. A failure leaves the run with none. */
const teamNotesFor = async (
  db: Database,
  run: RunRecord,
  readTeam: TeamMemoryReader
): Promise<TeamPromptNotes[]> => {
  try {
    return await loadTeamPromptNotes(readTeam, await teamsOfAgent(db, run));
  } catch (error) {
    // Team memory is extra context: a run that cannot load it starts without it.
    console.error(
      `Loading team memory for run ${run.id} failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    return [];
  }
};

/** The run's notes and rules, read once. Private notes load by the rule in `library/private-notes.ts`. */
const memoryFor = async (
  db: Database,
  run: RunRecord,
  read: MemoryFileReader,
  readTeam: TeamMemoryReader | undefined
): Promise<PromptMemory> => {
  const [agentRow] = await db
    .select({ remember: agents.remember })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.workspaceId, run.workspaceId))
    )
    .limit(1);
  const [workspaceRow] = await db
    .select({ never: workspaces.neverRemember })
    .from(workspaces)
    .where(eq(workspaces.id, run.workspaceId))
    .limit(1);
  const memory = await loadPromptMemory(read, {
    agentRemember: agentRow?.remember ?? "",
    privateNotesUserId: await loadPrivateNotesUser(db, run),
    workspaceNever: workspaceRow?.never ?? "",
  });
  return readTeam
    ? { ...memory, team: await teamNotesFor(db, run, readTeam) }
    : memory;
};

export const buildLaunchContext = async (
  db: Database,
  run: RunRecord,
  agent: AgentRecord,
  options: {
    readMemoryFile?: MemoryFileReader;
    readTeamMemoryFile?: TeamMemoryReader;
  } = {}
): Promise<LaunchContext> => {
  const inLeadRoom = (await leadRoomOf(db, run)) !== null;
  const assigned = inLeadRoom
    ? []
    : await db
        .select({ id: connectors.id, name: connectors.name })
        .from(agentConnectors)
        .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
        .where(
          and(
            eq(agentConnectors.agentId, run.agentId),
            eq(agentConnectors.workspaceId, run.workspaceId)
          )
        )
        .orderBy(
          asc(agentConnectors.createdAt),
          asc(agentConnectors.connectorId)
        );
  const scope = await effectiveRunScope(db, run.workspaceId, run.id);
  const multiPerson = await sessionSupportsSpeakers(db, run);
  return {
    connectors: assigned.filter((connector) =>
      scopeAllows(scope, "connectors", connector.id)
    ),
    handoffNames: await handsToNames(db, agent),
    memory: options.readMemoryFile
      ? await memoryFor(
          db,
          run,
          options.readMemoryFile,
          options.readTeamMemoryFile
        )
      : null,
    model: modelOfRun(run, agent),
    multiPerson,
    scope,
    slack: await slackGuidanceFor(db, {
      agentId: run.agentId,
      workspaceId: run.workspaceId,
    }),
    teamRoom: inLeadRoom,
  };
};
