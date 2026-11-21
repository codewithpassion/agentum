import { expect, test } from "bun:test";
import type { JobSentence, TeamMember, TeamMemberKind } from "@repo/db/shared";
import { ForbiddenError } from "@repo/services/authz";
import {
  profileSetInputSchema,
  teamCreateInputSchema,
} from "@repo/services/teams";
import {
  addableAgents,
  addablePeople,
  canEditTeam,
  createTeamWithMembers,
  HANDLE_MAX,
  HANDLE_MIN,
  handleError,
  leadChoices,
  memberRows,
  NAME_MAX,
  nameError,
  normalizeHandle,
  RULES_MAX,
  type TeamAgent,
  type TeamsWriteApi,
  teamJobs,
  UNKNOWN_AGENT,
  UNKNOWN_PERSON,
} from "./team-logic.ts";

const member = (memberKind: TeamMemberKind, memberId: string): TeamMember => ({
  isHome: false,
  memberId,
  memberKind,
  teamId: "team-1",
});

const agent = (
  id: string,
  name: string,
  jobLine = `${name} job`
): TeamAgent => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  id,
  jobLine,
  name,
});

const makeJob = (
  id: string,
  agentId: string,
  overrides: Partial<JobSentence> = {}
): JobSentence => ({
  agent: { id: agentId, name: agentId },
  asksBefore: null,
  awaitingApproval: false,
  deliversTo: null,
  does: "Sorts mail",
  enabled: true,
  id,
  lastRunAt: null,
  lastRunOk: null,
  nextRunAt: null,
  source: "routine",
  when: "Every weekday at 9:00",
  ...overrides,
});

const VALID_HANDLE_NAME = "Dom";

test("canEditTeam allows an admin, the owner, and nobody else", () => {
  expect(
    canEditTeam({ isAdmin: true, ownerUserId: null, userId: "user-x" })
  ).toBe(true);
  expect(
    canEditTeam({ isAdmin: false, ownerUserId: "user-1", userId: "user-1" })
  ).toBe(true);
  expect(
    canEditTeam({ isAdmin: false, ownerUserId: "user-1", userId: "user-2" })
  ).toBe(false);
  expect(
    canEditTeam({ isAdmin: false, ownerUserId: null, userId: "user-2" })
  ).toBe(false);
});

test("canEditTeam denies a missing user id, even when the owner is also missing", () => {
  expect(canEditTeam({ isAdmin: false, ownerUserId: null, userId: null })).toBe(
    false
  );
  expect(
    canEditTeam({ isAdmin: false, ownerUserId: null, userId: undefined })
  ).toBe(false);
  expect(canEditTeam({ isAdmin: false, ownerUserId: null, userId: "" })).toBe(
    false
  );
});

test("memberRows lists agents before people, with the lead first", () => {
  const team = {
    leadAgentId: "agent-zara",
    members: [
      member("user", "user-bo"),
      member("agent", "agent-ada"),
      member("agent", "agent-zara"),
      member("user", "user-al"),
    ],
  };
  const rows = memberRows(
    team,
    [agent("agent-ada", "Ada"), agent("agent-zara", "Zara")],
    [
      { name: "Bo", userId: "user-bo" },
      { name: "Al", userId: "user-al" },
    ],
    null
  );
  expect(rows.map((row) => [row.kind, row.label, row.isLead])).toEqual([
    ["agent", "Zara", true],
    ["agent", "Ada", false],
    ["user", "Al", false],
    ["user", "Bo", false],
  ]);
});

test("memberRows fills agent rows with the avatar and job line, and person rows with none", () => {
  const team = {
    leadAgentId: null,
    members: [member("agent", "agent-ada"), member("user", "user-bo")],
  };
  const [agentRow, personRow] = memberRows(
    team,
    [agent("agent-ada", "Ada", "Triages mail")],
    [{ name: "Bo", userId: "user-bo" }],
    null
  );
  expect(agentRow).toEqual({
    avatar: { color: "slate", glyph: "A" },
    detail: "Triages mail",
    id: "agent-ada",
    isLead: false,
    isYou: false,
    kind: "agent",
    label: "Ada",
  });
  expect(personRow).toEqual({
    avatar: null,
    detail: "",
    id: "user-bo",
    isLead: false,
    isYou: false,
    kind: "user",
    label: "Bo",
  });
});

test("memberRows marks the viewer's own person row", () => {
  const team = {
    leadAgentId: null,
    members: [member("user", "user-bo"), member("user", "user-al")],
  };
  const rows = memberRows(
    team,
    [],
    [
      { name: "Bo", userId: "user-bo" },
      { name: "Al", userId: "user-al" },
    ],
    "user-al"
  );
  expect(rows.map((row) => [row.label, row.isYou])).toEqual([
    ["Al", true],
    ["Bo", false],
  ]);
});

test("memberRows keeps rows for members the lookups no longer know", () => {
  const team = {
    leadAgentId: "agent-gone",
    members: [
      member("agent", "agent-gone"),
      member("agent", "agent-ada"),
      member("user", "user-gone"),
    ],
  };
  const rows = memberRows(team, [agent("agent-ada", "Ada")], [], "user-gone");
  expect(rows).toEqual([
    {
      avatar: null,
      detail: "",
      id: "agent-gone",
      isLead: true,
      isYou: false,
      kind: "agent",
      label: UNKNOWN_AGENT,
    },
    {
      avatar: { color: "slate", glyph: "A" },
      detail: "Ada job",
      id: "agent-ada",
      isLead: false,
      isYou: false,
      kind: "agent",
      label: "Ada",
    },
    {
      avatar: null,
      detail: "",
      id: "user-gone",
      isLead: false,
      isYou: true,
      kind: "user",
      label: UNKNOWN_PERSON,
    },
  ]);
});

test("memberRows labels every person unknown when the people lookup is null", () => {
  const team = {
    leadAgentId: null,
    members: [member("user", "user-bo"), member("user", "user-al")],
  };
  const rows = memberRows(team, [], null, "user-bo");
  expect(rows.map((row) => [row.label, row.isYou])).toEqual([
    [UNKNOWN_PERSON, true],
    [UNKNOWN_PERSON, false],
  ]);
});

test("addableAgents leaves out agents already in the team, by name", () => {
  const team = {
    members: [member("agent", "agent-zed"), member("user", "agent-ada")],
  };
  const result = addableAgents(team, [
    agent("agent-zed", "Zed"),
    agent("agent-ada", "Ada"),
    agent("agent-bea", "Bea"),
    agent("agent-cy", "Cy"),
  ]);
  // A person with the same id as an agent does not take the agent off the list.
  expect(result.map((entry) => entry.id)).toEqual([
    "agent-ada",
    "agent-bea",
    "agent-cy",
  ]);
});

test("addablePeople leaves out people already in the team, by name", () => {
  const team = {
    members: [member("user", "user-bo"), member("agent", "user-al")],
  };
  const result = addablePeople(team, [
    { name: "Cy", userId: "user-cy" },
    { name: "Bo", userId: "user-bo" },
    { name: "Al", userId: "user-al" },
    { name: "Dee", userId: "user-dee" },
  ]);
  expect(result.map((entry) => entry.userId)).toEqual([
    "user-al",
    "user-cy",
    "user-dee",
  ]);
});

test("addablePeople returns nobody when the lookup failed", () => {
  expect(addablePeople({ members: [] }, null)).toEqual([]);
});

test("leadChoices lists only the agent members, by name", () => {
  const team = {
    members: [
      member("user", "user-bo"),
      member("agent", "agent-zed"),
      member("agent", "agent-gone"),
      member("agent", "agent-ada"),
    ],
  };
  expect(
    leadChoices(team, [agent("agent-zed", "Zed"), agent("agent-ada", "Ada")])
  ).toEqual([
    { id: "agent-ada", label: "Ada" },
    { id: "agent-gone", label: UNKNOWN_AGENT },
    { id: "agent-zed", label: "Zed" },
  ]);
});

test("teamJobs keeps only enabled, approved jobs of the team's agents", () => {
  const team = {
    members: [member("agent", "agent-ada"), member("user", "agent-bo")],
  };
  const jobs = [
    makeJob("job-ok", "agent-ada"),
    makeJob("job-second", "agent-ada"),
    makeJob("job-off", "agent-ada", { enabled: false }),
    makeJob("job-pending", "agent-ada", { awaitingApproval: true }),
    makeJob("job-outside", "agent-cy"),
    makeJob("job-person-id", "agent-bo"),
  ];
  expect(teamJobs(jobs, team).map((job) => job.id)).toEqual([
    "job-ok",
    "job-second",
  ]);
});

test("normalizeHandle trims, drops leading @ signs, and lowercases", () => {
  expect(normalizeHandle("  @Dom-Fretz ")).toBe("dom-fretz");
  expect(normalizeHandle("@@dom")).toBe("dom");
  expect(normalizeHandle("dom")).toBe("dom");
});

test("handleError accepts a valid handle", () => {
  expect(handleError("dom-fretz")).toBeNull();
  expect(handleError("ab")).toBeNull();
  expect(handleError("a".repeat(HANDLE_MAX))).toBeNull();
  expect(handleError("a1")).toBeNull();
});

test("handleError reports the length limits", () => {
  const lengthMessage = `A handle is ${HANDLE_MIN} to ${HANDLE_MAX} characters.`;
  expect(HANDLE_MIN).toBe(2);
  expect(HANDLE_MAX).toBe(40);
  expect(handleError("a")).toBe(lengthMessage);
  expect(handleError("")).toBe(lengthMessage);
  expect(handleError("a".repeat(HANDLE_MAX + 1))).toBe(lengthMessage);
});

test("handleError reports characters outside the pattern", () => {
  const patternMessage =
    "Use lowercase letters and digits, with single hyphens between them.";
  for (const handle of [
    "Dom",
    "dom fretz",
    "dom--fretz",
    "-dom",
    "dom-",
    "dom_x",
  ]) {
    expect(handleError(handle)).toBe(patternMessage);
  }
});

test("nameError rejects an empty or blank name", () => {
  expect(nameError("")).toBe("Enter a name.");
  expect(nameError("   ")).toBe("Enter a name.");
});

test("nameError rejects a name over the limit and accepts one at it", () => {
  expect(NAME_MAX).toBe(80);
  expect(nameError("x".repeat(NAME_MAX + 1))).toBe(
    `A name is at most ${NAME_MAX} characters.`
  );
  expect(nameError("x".repeat(NAME_MAX))).toBeNull();
  expect(nameError("Dom")).toBeNull();
});

test("the rules limit matches the service", () => {
  expect(RULES_MAX).toBe(20_000);
  const create = (rules: string) =>
    teamCreateInputSchema.safeParse({ name: "Ops", rules }).success;
  expect(create("x".repeat(RULES_MAX))).toBe(true);
  expect(create("x".repeat(RULES_MAX + 1))).toBe(false);
});

test("handleError agrees with the service's handle rule", () => {
  const handles = [
    "ab",
    "a",
    "a".repeat(41),
    "a".repeat(40),
    "Dom",
    "dom-fretz",
    "dom--fretz",
    "-dom",
    "dom-",
    "dom_x",
    "a1",
  ];
  for (const handle of handles) {
    const serviceAccepts = profileSetInputSchema.safeParse({
      handle,
      name: VALID_HANDLE_NAME,
    }).success;
    expect(handleError(handle) === null).toBe(serviceAccepts);
  }
});

test("nameError agrees with the service's name rule", () => {
  const names = [
    "",
    "   ",
    "Dom",
    "x".repeat(NAME_MAX),
    "x".repeat(NAME_MAX + 1),
  ];
  for (const name of names) {
    const serviceAccepts = profileSetInputSchema.safeParse({
      handle: "dom",
      name,
    }).success;
    expect(nameError(name) === null).toBe(serviceAccepts);
  }
});

const recordingApi = (failingMemberId?: string) => {
  const created: { leadAgentId: string | null; name: string }[] = [];
  const added: Parameters<TeamsWriteApi["addMember"]>[0][] = [];
  const api: TeamsWriteApi = {
    addMember: (input) => {
      if (input.memberId === failingMemberId) {
        return Promise.reject(new Error("No access to that person."));
      }
      added.push(input);
      return Promise.resolve({});
    },
    create: (input) => {
      created.push(input);
      return Promise.resolve({ id: "team-new", name: input.name });
    },
  };
  return { added, api, created };
};

test("createTeamWithMembers creates the team with the lead and trimmed name", async () => {
  const { api, created } = recordingApi();
  const result = await createTeamWithMembers(api, {
    agentIds: ["agent-ada"],
    leadAgentId: "agent-ada",
    name: "  Ops  ",
    personIds: [],
  });
  expect(created).toEqual([{ leadAgentId: "agent-ada", name: "Ops" }]);
  expect(result).toEqual({
    failed: [],
    team: { id: "team-new", name: "Ops" },
  });
});

test("createTeamWithMembers reports the Forbidden message for another owner's agent", async () => {
  const api: TeamsWriteApi = {
    addMember: (input) =>
      input.memberKind === "agent"
        ? Promise.reject(new ForbiddenError("teams.add_agent"))
        : Promise.resolve({}),
    create: (input) => Promise.resolve({ id: "team-new", name: input.name }),
  };
  const result = await createTeamWithMembers(api, {
    agentIds: ["agent-theirs"],
    leadAgentId: null,
    name: "Ops",
    personIds: ["user-bo"],
  });
  expect(result.failed).toEqual([
    { id: "agent-theirs", reason: "Not allowed: teams.add_agent" },
  ]);
});

test("createTeamWithMembers does not add the lead a second time", async () => {
  const { added, api } = recordingApi();
  await createTeamWithMembers(api, {
    agentIds: ["agent-ada", "agent-zed"],
    leadAgentId: "agent-ada",
    name: "Ops",
    personIds: [],
  });
  expect(added.map((input) => input.memberId)).toEqual(["agent-zed"]);
});

test("createTeamWithMembers adds each other agent and each person once, not home", async () => {
  const { added, api } = recordingApi();
  await createTeamWithMembers(api, {
    agentIds: ["agent-ada", "agent-zed", "agent-bea"],
    leadAgentId: "agent-ada",
    name: "Ops",
    personIds: ["user-bo", "user-al"],
  });
  const described = added
    .map(
      (input) =>
        `${input.memberKind}:${input.memberId}:${input.teamId}:${input.isHome}`
    )
    .sort();
  expect(described).toEqual([
    "agent:agent-bea:team-new:false",
    "agent:agent-zed:team-new:false",
    "user:user-al:team-new:false",
    "user:user-bo:team-new:false",
  ]);
});

test("createTeamWithMembers collects a failed addMember without throwing", async () => {
  const { api } = recordingApi("user-bo");
  const result = await createTeamWithMembers(api, {
    agentIds: ["agent-zed"],
    leadAgentId: null,
    name: "Ops",
    personIds: ["user-bo", "user-al"],
  });
  expect(result.failed).toEqual([
    { id: "user-bo", reason: "No access to that person." },
  ]);
  expect(result.team.id).toBe("team-new");
});

test("createTeamWithMembers gives a generic reason when a non-Error is thrown", async () => {
  const api: TeamsWriteApi = {
    addMember: () => Promise.reject("nope"),
    create: (input) => Promise.resolve({ id: "team-new", name: input.name }),
  };
  const result = await createTeamWithMembers(api, {
    agentIds: ["agent-zed"],
    leadAgentId: null,
    name: "Ops",
    personIds: [],
  });
  expect(result.failed).toEqual([
    { id: "agent-zed", reason: "Could not add." },
  ]);
});

test("createTeamWithMembers rejects when create fails and adds no one", async () => {
  const added: string[] = [];
  const api: TeamsWriteApi = {
    addMember: (input) => {
      added.push(input.memberId);
      return Promise.resolve({});
    },
    create: () => Promise.reject(new Error("boom")),
  };
  await expect(
    createTeamWithMembers(api, {
      agentIds: ["agent-zed"],
      leadAgentId: null,
      name: "Ops",
      personIds: ["user-bo"],
    })
  ).rejects.toThrow("boom");
  expect(added).toEqual([]);
});
