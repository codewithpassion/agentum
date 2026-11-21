import type { JobSentence, MemberProfile, Team } from "@repo/db/shared";
import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { FolderLink } from "./folder-link.tsx";
import { LeadListensSwitch } from "./lead-listens-switch.tsx";
import { LeadPicker } from "./lead-picker.tsx";
import { MemberList } from "./member-list.tsx";
import { NewTeamButton } from "./new-team-button.tsx";
import { ProfileForm } from "./profile-form.tsx";
import { RoomLink } from "./room-link.tsx";
import { RulesEditor } from "./rules-editor.tsx";
import { SlackLink } from "./slack-link.tsx";
import { TeamJobs } from "./team-jobs.tsx";
import {
  addableAgents,
  addablePeople,
  leadChoices,
  type MemberRow,
  memberRows,
  type TeamAgent,
  type TeamPerson,
  teamJobs,
} from "./team-logic.ts";
import { TeamMemoryPanel } from "./team-memory.tsx";
import { TeamSection } from "./team-section.tsx";

export interface TeamPageProps {
  /** Every active agent in the workspace. */
  agents: readonly TeamAgent[];
  /** True when the caller may change the team: an org admin or the team's owner. */
  canEdit: boolean;
  /** Every job in the workspace, or null when the jobs could not be read. */
  jobs: readonly JobSentence[] | null;
  /** The people of the workspace, or null when the lookup failed. */
  people: readonly TeamPerson[] | null;
  /** The caller's name and handle, or null before they set one. */
  profile: MemberProfile | null;
  team: Team;
  /** The caller's user id. */
  userId: string | null | undefined;
}

/** What a person does to a team, each one a tRPC call followed by a reload of the page data. */
function useTeamChanges(teamId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (change: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await change();
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [router]
  );

  const addMember = useCallback(
    (memberKind: "agent" | "user", memberId: string) =>
      run(() =>
        getTrpc().teams.addMember.mutate({
          isHome: false,
          memberId,
          memberKind,
          teamId,
        })
      ),
    [run, teamId]
  );
  const removeMember = useCallback(
    (row: MemberRow) =>
      run(() =>
        getTrpc().teams.removeMember.mutate({
          memberId: row.id,
          memberKind: row.kind,
          teamId,
        })
      ),
    [run, teamId]
  );
  // The lead picker and the rules editor show their own errors, so these throw.
  const setLead = useCallback(
    async (agentId: string | null) => {
      await getTrpc().teams.setLead.mutate({ agentId, teamId });
      await router.invalidate();
    },
    [router, teamId]
  );
  const setLeadListens = useCallback(
    async (leadListens: boolean) => {
      await getTrpc().teams.update.mutate({ leadListens, teamId });
      await router.invalidate();
    },
    [router, teamId]
  );
  const setRules = useCallback(
    async (rules: string) => {
      await getTrpc().teams.setRules.mutate({ rules, teamId });
      await router.invalidate();
    },
    [router, teamId]
  );
  const setProfile = useCallback(
    async (values: { handle: string; name: string }) => {
      await getTrpc().teams.profiles.set.mutate(values);
      await router.invalidate();
    },
    [router]
  );
  return {
    addMember,
    busy,
    error,
    removeMember,
    setLead,
    setLeadListens,
    setProfile,
    setRules,
  };
}

function Aside({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-8">{children}</div>;
}

/**
 * One team: its members, lead, rules, team memory, shared folder, the standing jobs of its
 * agents, and how the team knows the caller. Only an admin or the team's owner
 * can change the team. Anyone can set their own name and handle.
 */
export function TeamPage({
  agents,
  canEdit,
  jobs,
  people,
  profile,
  team,
  userId,
}: TeamPageProps) {
  const changes = useTeamChanges(team.id);
  const rows = memberRows(team, agents, people, userId);
  const lead = rows.find((row) => row.isLead);
  const standing = jobs === null ? null : teamJobs(jobs, team);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            className="text-muted-foreground text-sm"
            search={undefined}
            to="/teams"
          >
            All teams
          </Link>
          <h1 className="font-heading text-3xl text-foreground">{team.name}</h1>
          <p className="text-muted-foreground text-sm">
            {lead === undefined ? "No lead." : `${lead.label} leads.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RoomLink teamId={team.id} teamName={team.name} />
          <NewTeamButton agents={agents} people={people} youId={userId} />
        </div>
      </header>
      {canEdit ? null : (
        <p className="text-muted-foreground text-sm">
          Only an admin or the team's owner can change this team.
        </p>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <TeamSection title="Members">
            <MemberList
              addableAgents={addableAgents(team, agents)}
              addablePeople={addablePeople(team, people)}
              busy={changes.busy}
              canEdit={canEdit}
              onAdd={changes.addMember}
              onRemove={changes.removeMember}
              rows={rows}
            />
            {changes.error === null ? null : (
              <p className="text-destructive text-sm" role="alert">
                {changes.error}
              </p>
            )}
          </TeamSection>
          <TeamSection title="Team rules">
            <RulesEditor
              canEdit={canEdit}
              onSave={changes.setRules}
              rules={team.rules}
            />
          </TeamSection>
          {canEdit && team.folderPath !== null ? (
            <TeamSection
              description="What the team's agents share, tidied by a team dream. Only the team's owner or an admin sees this."
              title="Team memory"
            >
              <TeamMemoryPanel teamId={team.id} teamName={team.name} />
            </TeamSection>
          ) : null}
        </div>
        <Aside>
          <TeamSection title="Lead">
            <LeadPicker
              canEdit={canEdit}
              choices={leadChoices(team, agents)}
              leadId={team.leadAgentId}
              onChange={changes.setLead}
            />
            {canEdit ? (
              <LeadListensSwitch
                checked={team.leadListens}
                onChange={changes.setLeadListens}
              />
            ) : null}
          </TeamSection>
          <TeamSection
            description="Link the team's room to one Slack channel."
            title="Slack"
          >
            <SlackLink agents={agents} canEdit={canEdit} teamId={team.id} />
          </TeamSection>
          <TeamSection title="Shared folder">
            <FolderLink folderPath={team.folderPath} />
          </TeamSection>
          {standing === null ? null : (
            <TeamSection title="Standing jobs">
              <TeamJobs jobs={standing} />
            </TeamSection>
          )}
          <TeamSection
            description="Your name and handle in team rooms. Agents and people use the handle to mention you."
            title="How the team knows you"
          >
            <ProfileForm initial={profile} onSave={changes.setProfile} />
          </TeamSection>
        </Aside>
      </div>
    </div>
  );
}
