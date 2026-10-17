import { expect, test } from "bun:test";
import type {
  AgentSkill,
  SkillAssignment,
  SkillSummary,
  SkillVersion,
} from "#/integrations/trpc/types";
import {
  agentAssignments,
  agentProposals,
  approvedVersions,
  assignableSkills,
  assignedSkills,
  assignLabel,
  pinChoice,
  pinValue,
} from "./agent-skills-logic.ts";

const names = new Map([
  ["a1", "Pelican"],
  ["a2", "Heron"],
]);

const skill = (
  id: string,
  name: string,
  ownerAgentId: string | null,
  latestApprovedVersion: number | null
): SkillSummary =>
  ({
    createdAt: "2026-10-01T00:00:00Z",
    id,
    latestApprovedVersion,
    latestVersion: latestApprovedVersion,
    name,
    ownerAgentId,
    updatedAt: "2026-10-01T00:00:00Z",
  }) as SkillSummary;

const assignment = (
  agentId: string,
  skillId: string,
  pinnedVersion: number | null = null
): SkillAssignment => ({ agentId, pinnedVersion, skillId });

const version = (
  skillId: string,
  number: number,
  status: SkillVersion["status"],
  author: SkillVersion["author"],
  message = "change"
): SkillVersion =>
  ({
    approvedAt: null,
    approvedBy: null,
    author,
    createdAt: "2026-10-01T00:00:00Z",
    id: `${skillId}-${number}`,
    message,
    number,
    parent: null,
    skillId,
    status,
  }) as SkillVersion;

const resolved = (
  skillId: string,
  versionNumber: number,
  pinned: boolean
): AgentSkill =>
  ({
    files: [],
    name: skillId,
    pinned,
    skillId,
    version: versionNumber,
  }) as AgentSkill;

const skills = [
  skill("s1", "research", "a1", 3),
  skill("s2", "writing", null, 1),
  skill("s3", "draft", "a2", null),
];

test("agentAssignments keeps only the rows of one agent", () => {
  const rows = [
    assignment("a1", "s1"),
    assignment("a2", "s1"),
    assignment("a1", "s2", 1),
  ];
  expect(agentAssignments(rows, "a1")).toEqual([
    assignment("a1", "s1"),
    assignment("a1", "s2", 1),
  ]);
  expect(agentAssignments(rows, "nobody")).toEqual([]);
});

test("assignedSkills joins the name, owner and resolved version", () => {
  const rows = [
    assignment("a1", "s1"),
    assignment("a1", "s2", 1),
    assignment("a1", "s3"),
  ];
  const result = assignedSkills(
    rows,
    skills,
    [resolved("s1", 3, false), resolved("s2", 1, true)],
    names
  );
  expect(result).toEqual([
    {
      name: "research",
      owner: "Pelican",
      pinned: false,
      pinnedVersion: null,
      skillId: "s1",
      version: 3,
    },
    {
      name: "writing",
      owner: "People",
      pinned: true,
      pinnedVersion: 1,
      skillId: "s2",
      version: 1,
    },
    {
      name: "draft",
      owner: "Heron",
      pinned: false,
      pinnedVersion: null,
      skillId: "s3",
      version: null,
    },
  ]);
});

test("assignedSkills falls back when the skill is missing from the list", () => {
  const [row] = assignedSkills([assignment("a1", "gone")], [], [], names);
  expect(row).toMatchObject({
    name: "gone",
    owner: "Unknown owner",
    version: null,
  });
});

test("assignableSkills leaves out carried skills and skills with no approved version", () => {
  const carried = [assignment("a1", "s1")];
  expect(assignableSkills(skills, carried).map((item) => item.id)).toEqual([
    "s2",
  ]);
  expect(assignableSkills(skills, []).map((item) => item.id)).toEqual([
    "s1",
    "s2",
  ]);
});

test("assignLabel shows the name and owner", () => {
  expect(assignLabel(skills[0] as SkillSummary, names)).toBe(
    "research (Pelican)"
  );
  expect(assignLabel(skills[1] as SkillSummary, names)).toBe(
    "writing (People)"
  );
});

test("agentProposals keeps only this agent's proposals, joined to the skill", () => {
  const proposals = [
    version(
      "s1",
      4,
      "proposed",
      { id: "a1", kind: "agent", runId: "r1" },
      "tighten"
    ),
    version(
      "s2",
      2,
      "proposed",
      { id: "a2", kind: "agent", runId: null },
      "other"
    ),
    version("s2", 3, "proposed", { id: "u1", kind: "user", runId: null }),
    version(
      "s3",
      1,
      "proposed",
      { id: "a1", kind: "agent", runId: null },
      "new draft"
    ),
  ];
  expect(agentProposals(proposals, skills, "a1", names)).toEqual([
    {
      key: "s1/4",
      message: "tighten",
      name: "research",
      owner: "Pelican",
      skillId: "s1",
      version: 4,
    },
    {
      key: "s3/1",
      message: "new draft",
      name: "draft",
      owner: "Heron",
      skillId: "s3",
      version: 1,
    },
  ]);
});

test("agentProposals falls back when the skill is missing from the list", () => {
  const proposals = [
    version("gone", 2, "proposed", { id: "a1", kind: "agent", runId: null }),
  ];
  expect(agentProposals(proposals, [], "a1", names)).toEqual([
    {
      key: "gone/2",
      message: "change",
      name: "gone",
      owner: "Unknown owner",
      skillId: "gone",
      version: 2,
    },
  ]);
});

test("approvedVersions keeps approved numbers, newest first", () => {
  const log = [
    version("s1", 1, "approved", { id: "u1", kind: "user", runId: null }),
    version("s1", 2, "rejected", { id: "u1", kind: "user", runId: null }),
    version("s1", 3, "proposed", { id: "u1", kind: "user", runId: null }),
    version("s1", 4, "approved", { id: "u1", kind: "user", runId: null }),
  ];
  expect(approvedVersions(log)).toEqual([4, 1]);
  expect(approvedVersions([])).toEqual([]);
});

test("pinValue and pinChoice round trip, with empty meaning follow", () => {
  expect(pinValue(null)).toBe("");
  expect(pinValue(2)).toBe("2");
  expect(pinChoice("")).toBeNull();
  expect(pinChoice("2")).toBe(2);
  expect(pinChoice(pinValue(7))).toBe(7);
});
