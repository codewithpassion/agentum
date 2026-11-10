/**
 * The agent profile page in one read, and the "Ask me before it..." switches.
 * It composes the services that already answer each row, so it holds no
 * queries of its own except the one for the run an agent is paused on.
 * Reads and writes are for a signed-in person: the underlying services refuse
 * a run or the system principal for most of them.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  type AgentRuntime,
  type AgentStatus,
  isPendingProposal,
  type MachineStatus,
  type SecretMode,
  type SlackAppStatus,
  type SlackListenMode,
} from "@repo/db/shared";
import { SWITCH_COVERS } from "@repo/protocol/requests";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  gateableActions,
  levelAsks,
  PLATFORM_TOOL_LABELS,
} from "./agent-profile/ask-before.ts";
import type { AgentRecord, AgentsService } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import type { ConnectorsService } from "./connectors.ts";
import { ServiceError } from "./errors.ts";
import { agentGrants } from "./library/access.ts";
import { agentHomePath } from "./library/home.ts";
import type { MachinesService } from "./machines.ts";
import { askLevelSetInputSchema, type RequestsService } from "./requests.ts";
import type { RoutinesService } from "./routines.ts";
import type { SecretsService } from "./secrets.ts";
import { visibleSessions } from "./sessions.ts";
import type { SkillsStoreService } from "./skills-store.ts";
import type { SlackAppsService } from "./slack-apps.ts";
import type { TaskListItem, TasksService } from "./tasks/service.ts";
import type { TriggersService } from "./triggers.ts";
import type { Principal } from "./workspaces.ts";

const READ_ACTION = "agent_profile.read";
const WRITE_ACTION = "agent_profile.ask_before";
const AGENT_KIND = "agent";
const RECENT_TASKS = 5;

const id = z.string().min(1).max(200);
export const profileInputSchema = z.strictObject({ agentId: id });
export const askBeforeInputSchema = profileInputSchema;
export const setAskBeforeInputSchema = z.strictObject({
  action: id,
  agentId: id,
  ask: z.boolean(),
});
export type ProfileInput = z.input<typeof profileInputSchema>;
export const setAskLevelInputSchema = askLevelSetInputSchema;
export type SetAskBeforeInput = z.input<typeof setAskBeforeInputSchema>;
export type SetAskLevelInput = z.input<typeof setAskLevelInputSchema>;

export interface AgentRef {
  id: string;
  name: string;
  slug: string;
}

export interface ProfileHeader {
  emailLocal: string | null;
  id: string;
  machine: { id: string; name: string; status: MachineStatus } | null;
  model: string;
  name: string;
  runtime: AgentRuntime;
  slug: string;
  status: AgentStatus;
  /** The newest run waiting on a person, if there is one. */
  waitingRun: { createdAt: string; runId: string; sessionId: string } | null;
}

export interface ProfileConnector {
  /** Tool names the agent may use, null for every tool. */
  allowedTools: string[] | null;
  connectorId: string;
  name: string;
  status: string;
  toolCount: number;
}

/** A granted secret as a chip. The value is never read. */
export interface ProfileSecret {
  id: string;
  mode: SecretMode;
  name: string;
}

export interface ProfileSkill {
  name: string;
  pinnedVersion: number | null;
  /** The newest version waiting for a decision, if any. */
  proposedVersion: number | null;
  skillId: string;
}

export interface ProfileTrigger {
  id: string;
  lastFiredAt: string | null;
  name: string;
  paused: boolean;
}

export interface ProfileRoutine extends ProfileTrigger {
  cron: string;
  nextRunAt: string | null;
  timezone: string;
}

export interface ProfileSlackApp {
  id: string;
  listenMode: SlackListenMode;
  status: SlackAppStatus;
}

export interface ProfileFolder {
  access: "read" | "write";
  /** The agent's own folder. */
  home: boolean;
  path: string;
}

export interface AgentProfile {
  channels: {
    /** Reserved until the mailbox arrives. */
    email: "reserved";
    slack: ProfileSlackApp | null;
  };
  /** The instructions. */
  does: string;
  handsTo: AgentRef[];
  header: ProfileHeader;
  library: { folders: ProfileFolder[] };
  receivesFrom: AgentRef[];
  recentTasks: TaskListItem[];
  skills: ProfileSkill[];
  startsOn: {
    routines: ProfileRoutine[];
    slackMention: ProfileSlackApp | null;
    triggers: ProfileTrigger[];
  };
  tools: { connectors: ProfileConnector[]; secrets: ProfileSecret[] };
  /** The soul. */
  voice: string;
}

export interface AskBeforeAction {
  /** The rule key. */
  action: string;
  /**
   * Platform tools the switch covers that the person chose Always allow for, in
   * plain words. Only set while the switch is on, since those tools run unasked.
   */
  allowed?: string[];
  /** True when the agent waits for a person before doing it. */
  ask: boolean;
  /** What else the switch gates, when a built-in says so. */
  covers?: string;
  /** The source the switch sits under: a connector's name, or "Built-in tools". */
  group: string;
  kind: "builtin" | "connector";
  /** "Xero: create bill". */
  label: string;
  /** True when a rule of the agent's own sets this against what its level says. */
  overridden: boolean;
}

/** The platform tool keys a switch also gates. */
const coveredKeys = (action: string): readonly string[] =>
  Object.hasOwn(SWITCH_COVERS, action) ? (SWITCH_COVERS[action] ?? []) : [];

type UserPrincipal = Extract<Principal, { kind: "user" }>;

const toRef = ({ id: refId, name, slug }: AgentRecord): AgentRef => ({
  id: refId,
  name,
  slug,
});

export const createAgentProfileService = ({
  agents,
  connectors,
  db,
  machines,
  requests,
  routines,
  secrets,
  skillsStore,
  slackApps,
  tasks,
  triggers,
}: {
  agents: Pick<AgentsService, "get" | "list">;
  connectors: Pick<ConnectorsService, "assignments" | "list" | "agentTools">;
  db: Database;
  machines: Pick<MachinesService, "list">;
  requests: Pick<
    RequestsService,
    "askLevel" | "listRules" | "removeRule" | "setAskLevel" | "setRule"
  >;
  routines: Pick<RoutinesService, "list">;
  secrets: Pick<SecretsService, "grantsOf" | "list">;
  skillsStore: Pick<SkillsStoreService, "assignments" | "list" | "proposals">;
  slackApps: Pick<SlackAppsService, "list">;
  tasks: Pick<TasksService, "list">;
  triggers: Pick<TriggersService, "list">;
}) => {
  const requireUser = (principal: Principal, action: string): UserPrincipal => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(action);
    }
    return principal;
  };

  /** The agent, or not_found for one that is missing or still a draft. */
  const loadAgent = async (
    user: UserPrincipal,
    action: string,
    agentId: string
  ): Promise<AgentRecord> => {
    authorize(user, action, {
      id: agentId,
      kind: AGENT_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await agents.get(user, agentId);
    if (agent.status === "draft") {
      throw new ServiceError("not_found", "Agent not found");
    }
    return agent;
  };

  const waitingRunOf = async (
    user: UserPrincipal,
    agentId: string
  ): Promise<ProfileHeader["waitingRun"]> => {
    const [row] = await db
      .select({
        createdAt: runs.createdAt,
        runId: runs.id,
        sessionId: runs.sessionId,
      })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, user.workspaceId),
          eq(runs.agentId, agentId),
          eq(runs.status, "waiting"),
          inArray(
            runs.sessionId,
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(await visibleSessions(db, user))
          )
        )
      )
      .orderBy(desc(runs.id))
      .limit(1);
    return row ?? null;
  };

  const skillRows = async (
    user: UserPrincipal,
    agentId: string
  ): Promise<ProfileSkill[]> => {
    const [assigned, all, proposed] = await Promise.all([
      skillsStore.assignments(user),
      skillsStore.list(user),
      skillsStore.proposals(user),
    ]);
    const names = new Map(all.map((skill) => [skill.id, skill.name]));
    // `proposals` is newest first, so the first version seen per skill is the newest.
    const proposedBySkill = new Map<string, number>();
    for (const version of proposed) {
      if (!proposedBySkill.has(version.skillId)) {
        proposedBySkill.set(version.skillId, version.number);
      }
    }
    return assigned
      .filter((row) => row.agentId === agentId && names.has(row.skillId))
      .map((row) => ({
        name: names.get(row.skillId) ?? row.skillId,
        pinnedVersion: row.pinnedVersion,
        proposedVersion: proposedBySkill.get(row.skillId) ?? null,
        skillId: row.skillId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const toolRows = async (
    user: UserPrincipal,
    agentId: string
  ): Promise<AgentProfile["tools"]> => {
    const [assigned, all, grantIds, secretList] = await Promise.all([
      connectors.assignments(user, { agentId }),
      connectors.list(user),
      secrets.grantsOf(user, agentId),
      secrets.list(user),
    ]);
    const byId = new Map(all.map((connector) => [connector.id, connector]));
    const granted = new Set(grantIds);
    return {
      connectors: assigned.flatMap((assignment) => {
        const connector = byId.get(assignment.connectorId);
        return connector
          ? [
              {
                allowedTools: assignment.allowedTools,
                connectorId: connector.id,
                name: connector.name,
                status: connector.status,
                toolCount: connector.tools.length,
              },
            ]
          : [];
      }),
      secrets: secretList
        .filter((secret) => granted.has(secret.id))
        .map(({ id: secretId, mode, name }) => ({ id: secretId, mode, name })),
    };
  };

  const startRows = async (user: UserPrincipal, agentId: string) => {
    const [triggerList, routineList, appList] = await Promise.all([
      triggers.list(user, { agentId }),
      routines.list(user, { agentId }),
      slackApps.list(user, { agentId }),
    ]);
    // A proposal waits in Needs you, and a revoked trigger is gone.
    const liveTriggers = triggerList.filter(
      (trigger) => trigger.revokedAt === null && !isPendingProposal(trigger)
    );
    const liveRoutines = routineList.filter(
      (routine) => !isPendingProposal(routine)
    );
    const app = appList.find((candidate) => candidate.status !== "revoked");
    const slack: ProfileSlackApp | null = app
      ? { id: app.id, listenMode: app.listenMode, status: app.status }
      : null;
    return {
      routines: liveRoutines.map(
        (routine): ProfileRoutine => ({
          cron: routine.cron,
          id: routine.id,
          lastFiredAt: routine.lastFiredAt,
          name: routine.name,
          nextRunAt: routine.nextRunAt,
          paused: routine.disabledAt !== null,
          timezone: routine.timezone,
        })
      ),
      slack,
      triggers: liveTriggers.map(
        (trigger): ProfileTrigger => ({
          id: trigger.id,
          lastFiredAt: trigger.lastFiredAt,
          name: trigger.name,
          paused: trigger.disabledAt !== null,
        })
      ),
    };
  };

  const profile = async (
    principal: Principal,
    raw: ProfileInput
  ): Promise<AgentProfile> => {
    const user = requireUser(principal, READ_ACTION);
    const { agentId } = profileInputSchema.parse(raw);
    const agent = await loadAgent(user, READ_ACTION, agentId);
    const [
      everyAgent,
      machineList,
      waitingRun,
      toolList,
      skillList,
      starts,
      recentTasks,
    ] = await Promise.all([
      agents.list(user, { includeArchived: true }),
      agent.machineId === null ? Promise.resolve([]) : machines.list(user),
      waitingRunOf(user, agent.id),
      toolRows(user, agent.id),
      skillRows(user, agent.id),
      startRows(user, agent.id),
      tasks.list(user, { agentId: agent.id, limit: RECENT_TASKS }),
    ]);
    const machine = machineList.find(
      ({ id: machineId }) => machineId === agent.machineId
    );
    // Active agents only, like `handsToNames` in the prompt.
    const activeAgents = everyAgent.filter(
      (other) => other.status === "active"
    );
    const byId = new Map(activeAgents.map((other) => [other.id, other]));
    return {
      channels: { email: "reserved", slack: starts.slack },
      does: agent.instructions,
      handsTo: agent.handsTo.flatMap((targetId) => {
        const target = byId.get(targetId);
        return target ? [toRef(target)] : [];
      }),
      header: {
        emailLocal: agent.emailLocal,
        id: agent.id,
        machine: machine
          ? { id: machine.id, name: machine.name, status: machine.status }
          : null,
        model: agent.model,
        name: agent.name,
        runtime: agent.runtime,
        slug: agent.slug,
        status: agent.status,
        waitingRun,
      },
      library: {
        folders: [
          { access: "write", home: true, path: agentHomePath(agent.slug) },
          { access: "read", home: false, path: "wiki" },
          ...(await agentGrants(db, user.workspaceId, agent.id)).map(
            ({ path, mode }): ProfileFolder => ({
              access: mode,
              home: false,
              path,
            })
          ),
        ],
      },
      receivesFrom: activeAgents
        .filter(
          (other) => other.id !== agent.id && other.handsTo.includes(agent.id)
        )
        .map(toRef),
      recentTasks,
      skills: skillList,
      startsOn: {
        routines: starts.routines,
        slackMention: starts.slack,
        triggers: starts.triggers,
      },
      tools: toolList,
      voice: agent.soul,
    };
  };

  /** Each action the agent can be asked about, with whether it waits for a person today. */
  const askBefore = async (
    principal: Principal,
    raw: ProfileInput
  ): Promise<AskBeforeAction[]> => {
    const user = requireUser(principal, READ_ACTION);
    const { agentId } = askBeforeInputSchema.parse(raw);
    const agent = await loadAgent(user, READ_ACTION, agentId);
    const [assignedConnectors, rules, level] = await Promise.all([
      connectors.agentTools(user, { agentId: agent.id }),
      requests.listRules(user, { agentId: agent.id }),
      requests.askLevel(user, { agentId: agent.id }),
    ]);
    // A rule in mode "allow" (from Always allow) is an override to off.
    const modes = new Map(
      rules
        .filter((rule) => !rule.toolKey.startsWith("mail:"))
        .map((rule) => [rule.toolKey, rule.mode])
    );
    const allowing = new Set(
      rules.filter((rule) => rule.mode === "allow").map((rule) => rule.toolKey)
    );
    return gateableActions(assignedConnectors).map((action) => {
      const mode = modes.get(action.key);
      const byLevel = levelAsks(level, action);
      const ask = mode === undefined ? byLevel : mode === "ask";
      const allowed = ask
        ? coveredKeys(action.key)
            .filter((key) => allowing.has(key))
            .map((key) => PLATFORM_TOOL_LABELS[key] ?? key)
        : [];
      return {
        action: action.key,
        ask,
        group: action.group,
        kind: action.kind,
        label: action.label,
        overridden: mode !== undefined && ask !== byLevel,
        ...(allowed.length === 0 ? {} : { allowed }),
        ...(action.covers === undefined ? {} : { covers: action.covers }),
      };
    });
  };

  /** The level the card shows: a preset, or custom for an agent whose rules decide. */
  const askLevel = async (principal: Principal, raw: ProfileInput) => {
    const user = requireUser(principal, READ_ACTION);
    const { agentId } = profileInputSchema.parse(raw);
    const agent = await loadAgent(user, READ_ACTION, agentId);
    return await requests.askLevel(user, { agentId: agent.id });
  };

  const setAskLevel = async (principal: Principal, raw: SetAskLevelInput) => {
    const user = requireUser(principal, WRITE_ACTION);
    const { agentId, level } = setAskLevelInputSchema.parse(raw);
    const agent = await loadAgent(user, WRITE_ACTION, agentId);
    await requests.setAskLevel(user, { agentId: agent.id, level });
  };

  /**
   * Turns "ask me before" on or off for one action. A switch that agrees with
   * the agent's level removes its rule, one that disagrees writes an override.
   * A key that is not one of the agent's gateable actions is refused.
   */
  const setAskBefore = async (
    principal: Principal,
    raw: SetAskBeforeInput
  ): Promise<void> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { action, agentId, ask } = setAskBeforeInputSchema.parse(raw);
    const agent = await loadAgent(user, WRITE_ACTION, agentId);
    const [assignedConnectors, level] = await Promise.all([
      connectors.agentTools(user, { agentId: agent.id }),
      requests.askLevel(user, { agentId: agent.id }),
    ]);
    const known = gateableActions(assignedConnectors).find(
      (candidate) => candidate.key === action
    );
    if (!known) {
      throw new ServiceError("invalid", `Unknown action: ${action}`);
    }
    if (ask === levelAsks(level, known)) {
      await requests.removeRule(user, { agentId: agent.id, toolKey: action });
    } else {
      await requests.setRule(user, {
        agentId: agent.id,
        mode: ask ? "ask" : "allow",
        toolKey: action,
      });
    }
    if (!ask) {
      return;
    }
    // An Always allow on a platform tool the switch covers would keep that tool
    // ungated while the switch reads on, so turning the switch on clears it.
    const covered = coveredKeys(action);
    if (covered.length === 0) {
      return;
    }
    for (const rule of await requests.listRules(user, { agentId: agent.id })) {
      if (rule.mode === "allow" && covered.includes(rule.toolKey)) {
        // biome-ignore lint/performance/noAwaitInLoops: at most a few rules
        await requests.removeRule(user, {
          agentId: agent.id,
          toolKey: rule.toolKey,
        });
      }
    }
  };

  /** Configuration for MCP without touching session-only credential or registry services. */
  const details = async (principal: Principal, raw: ProfileInput) => {
    const user = requireUser(principal, READ_ACTION);
    const { agentId } = profileInputSchema.parse(raw);
    const agent = await loadAgent(user, READ_ACTION, agentId);
    const [assignedConnectors, skills, machineList] = await Promise.all([
      connectors.agentTools(user, { agentId }),
      skillRows(user, agentId),
      agent.machineId === null ? Promise.resolve([]) : machines.list(user),
    ]);
    const machine = machineList.find((row) => row.id === agent.machineId);
    return {
      connectors: assignedConnectors.map(({ tools, ...row }) => ({
        ...row,
        toolCount: tools.length,
      })),
      machine: machine
        ? { id: machine.id, name: machine.name, status: machine.status }
        : null,
      skills,
    };
  };

  return {
    askBefore,
    askLevel,
    details,
    profile,
    setAskBefore,
    setAskLevel,
  };
};

export type AgentProfileService = ReturnType<typeof createAgentProfileService>;
