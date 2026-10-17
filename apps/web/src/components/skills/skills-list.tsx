import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { errorMessage } from "#/components/library/library-logic.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  SkillAssignment,
  SkillSummary,
  SkillVersion,
} from "#/integrations/trpc/types";
import {
  type AgentNames,
  ownerLabel,
  saveBase64File,
  versionLabel,
} from "./skills-logic.ts";

type Download = (skill: SkillSummary) => void;

function assignedLine(
  assigned: SkillAssignment[],
  agentNames: AgentNames
): string {
  if (assigned.length === 0) {
    return "Not assigned";
  }
  return assigned
    .map((assignment) => {
      const name = agentNames.get(assignment.agentId) ?? "Unknown agent";
      return assignment.pinnedVersion === null
        ? name
        : `${name} (v${assignment.pinnedVersion})`;
    })
    .join(", ");
}

function SkillRow({
  skill,
  agentNames,
  assigned,
  pendingCount,
  onDownload,
}: {
  skill: SkillSummary;
  agentNames: AgentNames;
  assigned: SkillAssignment[];
  pendingCount: number;
  onDownload: Download;
}) {
  const download = useCallback(() => onDownload(skill), [onDownload, skill]);
  const latest =
    skill.latestApprovedVersion === null
      ? "no approved version"
      : versionLabel(skill.latestApprovedVersion);

  return (
    <li className="flex items-center gap-4 py-3">
      <Link
        className="flex min-w-0 flex-1 flex-col gap-1 text-foreground no-underline hover:text-primary"
        data-testid="skills-row"
        params={{ skillId: skill.id }}
        to="/skills/$skillId"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{skill.name}</span>
          <Badge className="text-muted-foreground" variant="outline">
            {ownerLabel(skill.ownerAgentId, agentNames)}
          </Badge>
          {pendingCount > 0 ? (
            <Badge variant="secondary">{`${pendingCount} pending`}</Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground text-sm">
          {latest} · {assignedLine(assigned, agentNames)}
        </span>
      </Link>
      {skill.latestApprovedVersion === null ? null : (
        <Button
          data-testid="skill-download"
          onClick={download}
          size="sm"
          type="button"
          variant="outline"
        >
          Download
        </Button>
      )}
    </li>
  );
}

export interface SkillsListProps {
  agentNames: AgentNames;
  assignments: SkillAssignment[];
  proposals: SkillVersion[];
  skills: SkillSummary[];
}

export function SkillsList({
  skills,
  assignments,
  proposals,
  agentNames,
}: SkillsListProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = useCallback<Download>(async (skill) => {
    if (skill.latestApprovedVersion === null) {
      return;
    }
    setDownloadError(null);
    try {
      const archive = await getTrpc().skillStore.exportArchive.query({
        skillId: skill.id,
        version: skill.latestApprovedVersion,
      });
      saveBase64File(archive.filename, archive.data);
    } catch (cause) {
      setDownloadError(errorMessage(cause));
    }
  }, []);

  if (skills.length === 0) {
    return <p className="text-muted-foreground text-sm">No skills yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {downloadError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {downloadError}
        </p>
      )}
      <ul className="divide-y divide-border border-border border-y">
        {skills.map((skill) => (
          <SkillRow
            agentNames={agentNames}
            assigned={assignments.filter(
              (assignment) => assignment.skillId === skill.id
            )}
            key={skill.id}
            onDownload={download}
            pendingCount={
              proposals.filter((proposal) => proposal.skillId === skill.id)
                .length
            }
            skill={skill}
          />
        ))}
      </ul>
    </div>
  );
}
