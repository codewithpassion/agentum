import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import type {
  SkillAssignment,
  SkillInfo,
  SkillShown,
  SkillVersionInfo,
} from "@repo/mcp/ports";
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { isReadOnly } from "@repo/services/automation-access";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { skillScriptsExtension } from "../skill-scripts/run-skill-script.ts";
import type {
  SandboxRunInput,
  SkillScriptSandbox,
} from "../skill-scripts/sandbox-port.ts";
import { skillVersionFiles } from "../skill-scripts/skill-version-files.ts";
import { createMcpPorts } from "./ports.ts";

const READ_TOOLS = [
  "export_skill",
  "list_skills",
  "skill_diff",
  "skill_log",
  "skill_show",
];
const WRITE_TOOLS = [
  "approve_skill_version",
  "assign_skill",
  "commit_skill",
  "create_skill",
  "import_skill",
  "pin_skill",
  "reject_skill_version",
  "revert_skill",
  "unassign_skill",
];
const SCRIPT = "console.log('hi');";
const NOT_ALLOWED = "forbidden";

let composed: Composed;
let workspaceId: string;
let userPrincipal: Principal;

beforeEach(async () => {
  const db = migrated();
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(), sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  userPrincipal = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId,
  };
});

/** An MCP session for `principal`, with the tools that principal may see. */
const connect = async (principal: Principal) => {
  const ports = createMcpPorts({ principal, services: composed.services });
  const server = createHarbourmasterMcpServer(ports, {
    readOnly: isReadOnly(principal),
  });
  const { client, close } = await connectClient(server);
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ arguments: args, name }),
    close,
    listToolNames: async () =>
      (await client.listTools()).tools.map((tool) => tool.name),
  };
};

type Session = Awaited<ReturnType<typeof connect>>;
type Result = Awaited<ReturnType<Session["call"]>>;

const dataOf = (result: Result): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

const textOf = (result: Result): string =>
  (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

/** The code of a failed call, or null when the call succeeded. */
const errorCodeOf = (result: Result): unknown =>
  result.isError ? dataOf(result).code : null;

const versionOf = (result: Result) =>
  dataOf(result).version as SkillVersionInfo;

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Describes ${name}.\n---\n\n# ${name}\n`;

const files = (name: string) => [
  { content: skillMd(name), path: "SKILL.md" },
  { content: SCRIPT, path: "scripts/hello.ts" },
];

const makeAgent = (name: string) =>
  composed.services.agents.create(userPrincipal, {
    model: "fake",
    name,
    runtime: "fake",
  });

/** A run of `agentId`, and the principal a run's tools are called as. */
const runOf = async (agentId: string): Promise<Principal> => {
  const { runId } = await composed.services.runs.startRun(userPrincipal, {
    agentId,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  return { agentId, kind: "run", runId, workspaceId };
};

const createAs = async (
  session: Session,
  name: string
): Promise<SkillVersionInfo> => {
  const created = await session.call("create_skill", {
    files: files(name),
    message: "First version",
    name,
  });
  if (created.isError) {
    throw new Error(textOf(created));
  }
  return versionOf(created);
};

const skillsOf = async (session: Session) =>
  dataOf(await session.call("list_skills", {})).skills as SkillInfo[];

test("a person creates, commits, approves, assigns and pins", async () => {
  const agent = await makeAgent("Echo");
  const session = await connect(userPrincipal);

  const first = await createAs(session, "shout");
  expect(first.status).toBe("approved");
  expect(first.number).toBe(1);
  const { skillId } = first;

  const committed = await session.call("commit_skill", {
    baseVersion: 1,
    deletes: [{ path: "scripts/hello.ts" }].map((entry) => entry.path),
    message: "Drop the script",
    skillId,
    writes: [{ content: "A note.", path: "notes.md" }],
  });
  expect(committed.isError).toBeFalsy();
  expect(versionOf(committed).status).toBe("approved");
  expect(versionOf(committed).number).toBe(2);

  const stale = await session.call("commit_skill", {
    baseVersion: 1,
    message: "Late",
    skillId,
    writes: [{ content: "x", path: "late.md" }],
  });
  expect(errorCodeOf(stale)).toBe("conflict");

  const assigned = await session.call("assign_skill", {
    agent: agent.slug,
    skillId,
  });
  expect((dataOf(assigned).assignment as SkillAssignment).pinnedVersion).toBe(
    null
  );

  const [listed] = await skillsOf(session);
  expect(listed?.owner).toEqual({ agentId: null, name: "people" });
  expect(listed?.latestApprovedVersion).toBe(2);
  expect(listed?.assignedTo).toEqual([
    {
      agentId: agent.id,
      name: "Echo",
      pinned: false,
      slug: agent.slug,
      version: 2,
    },
  ]);

  const pinned = await session.call("pin_skill", {
    agent: agent.id,
    skillId,
    version: 1,
  });
  expect((dataOf(pinned).assignment as SkillAssignment).pinnedVersion).toBe(1);
  expect((await skillsOf(session))[0]?.assignedTo[0]).toMatchObject({
    pinned: true,
    version: 1,
  });

  const log = dataOf(await session.call("skill_log", { skillId }))
    .versions as SkillVersionInfo[];
  expect(log.map((entry) => entry.number)).toEqual([2, 1]);

  const diff = await session.call("skill_diff", { from: 1, skillId, to: 2 });
  expect(dataOf(diff).added).toEqual(["notes.md"]);
  expect(dataOf(diff).removed).toEqual(["scripts/hello.ts"]);

  const shown = await session.call("skill_show", {
    path: "notes.md",
    skillId,
    version: 2,
  });
  expect((dataOf(shown) as unknown as SkillShown).file).toEqual({
    content: "A note.",
    encoding: "utf8",
    path: "notes.md",
  });

  const unassigned = await session.call("unassign_skill", {
    agent: agent.id,
    skillId,
  });
  expect(unassigned.isError).toBeFalsy();
  expect((await skillsOf(session))[0]?.assignedTo).toEqual([]);
  await session.close();
});

test("a person approves and rejects a run's proposal", async () => {
  const agent = await makeAgent("Echo");
  const person = await connect(userPrincipal);
  const run = await connect(await runOf(agent.id));

  const proposed = await createAs(run, "tidy");
  const { skillId } = proposed;
  const second = await run.call("commit_skill", {
    baseVersion: 1,
    message: "More",
    skillId,
    writes: [{ content: "More.", path: "more.md" }],
  });
  expect(versionOf(second).number).toBe(2);

  expect((await skillsOf(person))[0]?.pendingProposals).toEqual([1, 2]);
  expect((await skillsOf(person))[0]?.latestApprovedVersion).toBeNull();

  expect(
    (await person.call("approve_skill_version", { skillId, version: 1 }))
      .isError
  ).toBeFalsy();
  const rejected = await person.call("reject_skill_version", {
    skillId,
    version: 2,
  });
  expect(versionOf(rejected).status).toBe("rejected");
  const [listed] = await skillsOf(person);
  expect(listed?.latestApprovedVersion).toBe(1);
  expect(listed?.pendingProposals).toEqual([]);
  expect(listed?.owner).toEqual({ agentId: agent.id, name: "Echo" });
  await person.close();
  await run.close();
});

test("a run creates and commits, is told the version is proposed, and runs it by number", async () => {
  const agent = await makeAgent("Echo");
  const principal = await runOf(agent.id);
  const run = await connect(principal);

  const created = await run.call("create_skill", {
    files: files("tidy"),
    message: "First version",
    name: "tidy",
  });
  expect(created.isError).toBeFalsy();
  const version = versionOf(created);
  expect(version.status).toBe("proposed");
  expect(textOf(created)).toContain("proposed");
  expect(textOf(created)).toContain("skill_show");
  expect(textOf(created)).toContain("run_skill_script");

  const committed = await run.call("commit_skill", {
    baseVersion: 1,
    message: "Change the script",
    skillId: version.skillId,
    writes: [{ content: "console.log('v2');", path: "scripts/hello.ts" }],
  });
  expect(versionOf(committed).status).toBe("proposed");
  expect(textOf(committed)).toContain("Version 2 is proposed");

  // The skill has no approved version, so the catalog is empty, and version 2 still runs.
  const calls: SandboxRunInput[] = [];
  const sandbox: SkillScriptSandbox = {
    run: (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok" });
    },
  };
  const extension = skillScriptsExtension(
    [],
    {
      list: () => Promise.resolve([]),
      read: () => Promise.reject(new Error("unused")),
    },
    sandbox,
    undefined,
    undefined,
    undefined,
    skillVersionFiles(composed.services.skillsStore, principal)
  );
  const tool = extension.tools?.find((t) => t.name === "run_skill_script");
  const output = await tool?.execute(
    { path: "scripts/hello.ts", skill: "tidy", version: 2 },
    {} as never,
    {} as never
  );
  expect(JSON.stringify(output)).toContain("ok");
  const [call] = calls;
  if (call === undefined) {
    throw new Error("the sandbox was not called");
  }
  expect(call.skill).toBe("tidy");
  const script = call.files.find((file) => file.path === "scripts/hello.ts");
  expect(new TextDecoder().decode(script?.bytes)).toBe("console.log('v2');");

  const refused = await tool?.execute(
    { path: "scripts/hello.ts", skill: "tidy", version: 9 },
    {} as never,
    {} as never
  );
  expect(JSON.stringify(refused)).toContain("Could not read version 9");
  expect(calls).toHaveLength(1);
  await run.close();
});

test("a run is refused approve, reject, assign, unassign, pin and commits to a skill it does not own", async () => {
  const agent = await makeAgent("Echo");
  const other = await makeAgent("Other");
  const person = await connect(userPrincipal);
  const run = await connect(await runOf(agent.id));
  const otherRun = await connect(await runOf(other.id));

  const shared = await createAs(person, "shared");
  await person.call("assign_skill", {
    agent: agent.id,
    skillId: shared.skillId,
  });
  const own = await createAs(run, "mine");

  for (const [tool, args] of [
    ["approve_skill_version", { skillId: own.skillId, version: 1 }],
    ["reject_skill_version", { skillId: own.skillId, version: 1 }],
    ["assign_skill", { agent: agent.id, skillId: own.skillId }],
    ["unassign_skill", { agent: agent.id, skillId: shared.skillId }],
    ["pin_skill", { agent: agent.id, skillId: shared.skillId, version: 1 }],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one refusal after the other
    expect(errorCodeOf(await run.call(tool, args))).toBe(NOT_ALLOWED);
  }

  // It carries the shared skill but does not own it.
  const assignedCommit = await run.call("commit_skill", {
    baseVersion: 1,
    message: "Mine now",
    skillId: shared.skillId,
    writes: [{ content: "x", path: "x.md" }],
  });
  expect(errorCodeOf(assignedCommit)).toBe(NOT_ALLOWED);

  // Another agent's skill is not visible at all.
  const hidden = await otherRun.call("skill_show", {
    skillId: own.skillId,
    version: 1,
  });
  expect(errorCodeOf(hidden)).toBe("not_found");
  const hiddenCommit = await otherRun.call("commit_skill", {
    baseVersion: 1,
    message: "Not mine",
    skillId: own.skillId,
    writes: [{ content: "x", path: "x.md" }],
  });
  expect(hiddenCommit.isError).toBe(true);

  // The run reads the version of the skill it carries.
  const readable = skillVersionFiles(
    composed.services.skillsStore,
    await runOf(agent.id)
  );
  expect((await readable("shared", 1)).map((file) => file.path)).toContain(
    "SKILL.md"
  );
  await person.close();
  await run.close();
  await otherRun.close();
});

test("import and export round trip, binary files and the executable flag included", async () => {
  const agent = await makeAgent("Echo");
  const person = await connect(userPrincipal);
  const created = await person.call("create_skill", {
    files: [
      { content: skillMd("pack"), path: "SKILL.md" },
      { content: "AAEC/w==", encoding: "base64", path: "data.bin" },
      { content: "#!/bin/sh\n", executable: true, path: "run.sh" },
    ],
    message: "Pack",
    name: "pack",
  });
  const { skillId } = versionOf(created);

  const exported = await person.call("export_skill", { skillId, version: 1 });
  const { archiveBase64, filename } = dataOf(exported) as {
    archiveBase64: string;
    filename: string;
  };
  expect(filename).toBe("pack.skill");
  expect(textOf(exported)).toContain(archiveBase64);

  // The same owner: the archive's tree comes back as a new version after the skill changed.
  await person.call("commit_skill", {
    baseVersion: 1,
    deletes: ["data.bin"],
    message: "Drop the data",
    skillId,
  });
  const again = await person.call("import_skill", { archiveBase64 });
  expect(dataOf(again).created).toBe(false);
  expect(versionOf(again).number).toBe(3);
  const restored = await person.call("skill_show", { skillId, version: 3 });
  expect(
    (dataOf(restored) as unknown as SkillShown).files.map((file) => file.path)
  ).toEqual(["SKILL.md", "data.bin", "run.sh"]);

  // Another owner: a new skill of the same name, proposed.
  const run = await connect(await runOf(agent.id));
  const imported = await run.call("import_skill", { archiveBase64 });
  expect(dataOf(imported).created).toBe(true);
  expect(versionOf(imported).status).toBe("proposed");
  expect(textOf(imported)).toContain("proposed");
  const copy = versionOf(imported);

  const binary = await run.call("skill_show", {
    path: "data.bin",
    skillId: copy.skillId,
    version: 1,
  });
  expect((dataOf(binary) as unknown as SkillShown).file).toEqual({
    content: "AAEC/w==",
    encoding: "base64",
    path: "data.bin",
  });
  const tree = (dataOf(binary) as unknown as SkillShown).files;
  expect(tree.find((file) => file.path === "run.sh")?.executable).toBe(true);
  expect(tree.map((file) => file.path)).toEqual([
    "SKILL.md",
    "data.bin",
    "run.sh",
  ]);

  const bad = await person.call("import_skill", {
    archiveBase64: "not base64!",
  });
  expect(errorCodeOf(bad)).toBe("validation");
  await person.close();
  await run.close();
});

test("a read-only key or connected app sees only the read tools", async () => {
  await makeAgent("Echo");
  const person = await connect(userPrincipal);
  const { skillId } = await createAs(person, "shout");
  await person.close();

  const readers: Principal[] = [
    {
      apiKey: { access: "read", id: "k1" },
      kind: "user",
      userId: "user_1",
      via: "api_key",
      workspaceId,
    },
    {
      kind: "user",
      oauthClient: { access: "read", clientId: "c1" },
      userId: "user_1",
      via: "oauth",
      workspaceId,
    },
  ];
  for (const principal of readers) {
    // biome-ignore lint/performance/noAwaitInLoops: each reader is its own session
    const session = await connect(principal);
    const names = await session.listToolNames();
    for (const name of READ_TOOLS) {
      expect(names).toContain(name);
    }
    for (const name of WRITE_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect((await skillsOf(session)).map((skill) => skill.id)).toEqual([
      skillId,
    ]);
    const ports = createMcpPorts({ principal, services: composed.services });
    await expect(
      ports.commitSkill({
        baseVersion: 1,
        deletes: [],
        message: "Blocked",
        skillId,
        writes: [{ content: "x", encoding: "utf8", path: "x.md" }],
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    await session.close();
  }
});
