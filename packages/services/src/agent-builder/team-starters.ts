import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { events } from "@repo/db/schema/events";
import { agentLibraryAccess, libraryEntries } from "@repo/db/schema/library";
import { skillAssignments } from "@repo/db/schema/skills";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { defaultAgentAvatar } from "@repo/db/shared";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { requireAgentManager } from "../admin-access.ts";
import { agentCreateSchema, slugify, slugSchema } from "../agents.ts";
import { authorize } from "../authz.ts";
import {
  CLOUD_DEFAULT_MODEL,
  CLOUD_OPENROUTER_DEFAULT_MODEL,
} from "../cloud/models.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import { requireAdminSession } from "../guards.ts";
import type { Clock } from "../runs/types.ts";
import { type TeamsService, teamCreateInputSchema } from "../teams.ts";
import type { Principal } from "../workspaces.ts";
import {
  agentDraftSchema,
  type BuilderCatalog,
  reconcileDraft,
} from "./draft.ts";
import { rowValues } from "./lifecycle.ts";
import { templateDraft } from "./templates.ts";

export const teamFromStarterInputSchema = z.enum(["sales", "back_office"]);
export const teamDraftSchema = z.strictObject({
  // A starter always has four agents, with the lead first; the lead is a member.
  members: z.tuple([
    agentDraftSchema,
    agentDraftSchema,
    agentDraftSchema,
    agentDraftSchema,
  ]),
  name: teamCreateInputSchema.shape.name,
  rules: teamCreateInputSchema.shape.rules,
});
export const createTeamInputSchema = z.strictObject({ draft: teamDraftSchema });
export type TeamDraft = z.output<typeof teamDraftSchema>;
const SKILL_RULE =
  "No member edits its own skill. Ask the owner to review any proposed skill change.";

export interface TeamStarterDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  /** Reads the created team back; its slack status comes from the app's own wiring. */
  teams: Pick<TeamsService, "get">;
}

export const createTeamStarterLifecycle = ({
  db,
  atomic,
  clock,
  catalog,
  teams: teamsService,
}: TeamStarterDeps & {
  catalog: (principal: Principal) => Promise<BuilderCatalog>;
}) => {
  const person = (principal: Principal) => {
    const user = requireAgentManager(principal, "agents.create");
    authorize(user, "agents.create", {
      kind: "agent",
      workspaceId: user.workspaceId,
    });
    authorize(user, "teams.write", {
      kind: "team",
      workspaceId: user.workspaceId,
    });
    return user;
  };

  const teamFromStarter = async (principal: Principal, key: string) => {
    person(principal);
    const starter = teamFromStarterInputSchema.parse(key);
    const choices = await catalog(principal);
    const sales = starter === "sales";
    const name = sales ? "Sales" : "Back office";
    // FR.1 has no lead, outreach or CRM template. Adapt its research, social
    // drafts and drive tidy templates rather than adding global template ids.
    const lead = templateDraft("weekly_report", choices).raw;
    lead.name = `${name} lead`;
    lead.does = `Coordinate the ${name} team, delegate to its three specialists, summarize progress and blockers, and propose member changes for their owners to approve.`;
    const research = templateDraft("lead_research", choices).raw;
    const outreach = templateDraft("social_drafts", choices).raw;
    outreach.name = "Outreach drafts";
    outreach.does =
      "Use the lead research to draft personal outreach messages. Check every claim and ask for approval before sending anything.";
    const crm = templateDraft("drive_tidy", choices).raw;
    crm.name = "CRM tidy";
    crm.does =
      "Review CRM records for duplicates, missing fields and stale details. Propose corrections and ask before merging, deleting or changing records.";
    crm.tools = research.tools;
    const members: TeamDraft["members"] = sales
      ? [lead, research, outreach, crm]
      : [
          lead,
          templateDraft("invoice_filing", choices).raw,
          templateDraft("drive_tidy", choices).raw,
          templateDraft("weekly_report", choices).raw,
        ];
    // A starter has no per-member setup, so every member runs on the workspace's
    // default runtime. With no key there is none, and reconcile reports the gap.
    const runsOn = choices.runtimes.includes("cloud")
      ? { runtime: "cloud" as const }
      : null;
    for (const member of members) {
      member.rules.push(SKILL_RULE);
      member.runsOn = runsOn;
    }
    const rules = `${SKILL_RULE}\nThe lead coordinates and proposes changes; each specialist stays in its lane. Share sources, progress and blockers in the team room. Ask a person before sending messages or changing business records.`;
    return {
      draft: { members, name, rules },
      members: members.map((member) => reconcileDraft(member, choices)),
    };
  };

  const assertSlugsFree = async (
    workspaceId: string,
    agentSlugs: string[],
    teamSlug: string
  ) => {
    const repeated = agentSlugs.find(
      (agentSlug, index) => agentSlugs.indexOf(agentSlug) !== index
    );
    if (repeated) {
      throw new ServiceError(
        "conflict",
        `Two members would share the slug "${repeated}", rename one`
      );
    }
    const [usedAgent] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          inArray(agents.slug, agentSlugs)
        )
      );
    if (usedAgent) {
      throw new ServiceError("conflict", `Slug "${usedAgent.slug}" is taken`);
    }
    const [usedTeam] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), eq(teams.slug, teamSlug)));
    if (usedTeam) {
      throw new ServiceError("conflict", "Team slug is already used");
    }
  };

  const writeUnique = async (statements: Statement[]) => {
    try {
      await atomic(statements);
    } catch (error) {
      // Another write may take a slug between the checks above and the insert.
      if (isUniqueViolation(error)) {
        throw Object.assign(
          new ServiceError("conflict", "A team or agent slug is already used"),
          { cause: error }
        );
      }
      throw error;
    }
  };

  const createTeam = async (
    principal: Principal,
    raw: z.input<typeof createTeamInputSchema>
  ) => {
    const user = person(principal);
    const { draft } = createTeamInputSchema.parse(raw);
    const choices = await catalog(principal);
    const now = clock.now().toISOString();
    const teamId = ulid();
    const slug = slugSchema.parse(slugify(draft.name));
    const folderPath = `teams/${slug}`;
    const prepared = draft.members.map((member) => {
      const { gaps } = reconcileDraft(member, choices, member);
      if (gaps.length || !member.runsOn) {
        throw new ServiceError(
          "invalid",
          `Settle ${member.name}: ${gaps.map((gap) => gap.question).join("; ")}`
        );
      }
      // Starters offer jobs and library paths as suggestions. These need their
      // separate review flows and are not silently applied at team confirmation.
      if (member.startsOn.length || member.library.length) {
        throw new ServiceError(
          "invalid",
          "Set up jobs and library paths after creating the team"
        );
      }
      const protectedDraft = {
        ...member,
        rules: [...new Set([...member.rules, SKILL_RULE])],
      };
      return {
        id: ulid(),
        ...agentCreateSchema.parse({
          ...rowValues(protectedDraft),
          machineId:
            member.runsOn.runtime === "machine"
              ? member.runsOn.machineId
              : null,
          model:
            member.runsOn.runtime === "cloud" &&
            !choices.runtimes.includes("managed")
              ? CLOUD_OPENROUTER_DEFAULT_MODEL
              : CLOUD_DEFAULT_MODEL,
          runtime: member.runsOn.runtime,
          slug: slugSchema.parse(slugify(member.name)),
        }),
        draft: member,
        slug: slugSchema.parse(slugify(member.name)),
      };
    });
    await assertSlugsFree(
      user.workspaceId,
      prepared.map((member) => member.slug),
      slug
    );
    const selectedTools = prepared.flatMap((member) => member.draft.tools);
    if (selectedTools.length) {
      const linked = await db
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.workspaceId, user.workspaceId),
            inArray(connectors.id, selectedTools)
          )
        );
      if (
        linked.some(
          (connector) => connector.secretId || connector.headerTemplate
        )
      ) {
        requireAdminSession(user, "connectors.assign");
      }
    }
    const existingFolders = await db
      .select()
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, user.workspaceId),
          inArray(libraryEntries.path, ["teams", folderPath])
        )
      );
    if (existingFolders.some((entry) => entry.kind !== "dir")) {
      throw new ServiceError(
        "invalid",
        "A file is in the way of the team folder"
      );
    }
    const statements: Statement[] = prepared.map(
      ({ draft: _draft, handsTo, runtimeConfig, ...member }) =>
        db.insert(agents).values({
          ...member,
          avatar: JSON.stringify(defaultAgentAvatar(member.name)),
          createdAt: now,
          createdBy: user.userId,
          handsTo: JSON.stringify(handsTo),
          runtimeConfig: JSON.stringify(runtimeConfig),
          status: "active",
          workspaceId: user.workspaceId,
        })
    );
    statements.push(
      db.insert(teams).values({
        createdAt: now,
        folderPath,
        id: teamId,
        leadAgentId: prepared[0]?.id,
        name: draft.name,
        ownerUserId: user.userId,
        rules: draft.rules.includes(SKILL_RULE)
          ? draft.rules
          : `${draft.rules}\n${SKILL_RULE}`,
        slug,
        workspaceId: user.workspaceId,
      })
    );
    for (const path of ["teams", folderPath]) {
      statements.push(
        db
          .insert(libraryEntries)
          .values({
            kind: "dir",
            mtime: now,
            parent: path === "teams" ? "" : "teams",
            path,
            size: 0,
            updatedById: user.userId,
            updatedByKind: "user",
            workspaceId: user.workspaceId,
          })
          .onConflictDoNothing()
      );
    }
    for (const member of prepared) {
      statements.push(
        db.insert(teamMembers).values({
          isHome: true,
          memberId: member.id,
          memberKind: "agent",
          teamId,
          workspaceId: user.workspaceId,
        }),
        db.insert(agentLibraryAccess).values({
          agentId: member.id,
          createdAt: now,
          mode: "write",
          path: folderPath,
          workspaceId: user.workspaceId,
        }),
        // Rules support ask/allow, not deny. Skills-store already makes every
        // run commit a proposal; this adds the explicit tool approval boundary.
        db.insert(agentToolRules).values({
          agentId: member.id,
          id: ulid(),
          mode: "ask",
          toolKey: "harbourmaster/commit_skill",
          updatedAt: now,
          updatedBy: user.userId,
          workspaceId: user.workspaceId,
        }),
        db.insert(events).values({
          actorId: user.userId,
          actorKind: "user",
          agentId: member.id,
          createdAt: now,
          id: ulid(),
          payload: JSON.stringify({
            name: member.name,
            runtime: member.runtime,
            slug: member.slug,
          }),
          type: "agent.created",
          workspaceId: user.workspaceId,
        }),
        ...member.draft.tools.map((connectorId) =>
          db.insert(agentConnectors).values({
            agentId: member.id,
            connectorId,
            createdAt: now,
            workspaceId: user.workspaceId,
          })
        ),
        ...member.draft.skills.map((skillId) =>
          db.insert(skillAssignments).values({
            agentId: member.id,
            createdAt: now,
            skillId,
            workspaceId: user.workspaceId,
          })
        )
      );
    }
    await writeUnique(statements);
    return teamsService.get(user, teamId);
  };
  return { createTeam, teamFromStarter };
};
