import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { libraryEntries } from "@repo/db/schema/library";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "@repo/services/events";
import { createLibraryService } from "@repo/services/library";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import type { LibraryOps } from "./library-fs.ts";
import { runLibraryBash } from "./run.ts";

const WORKSPACE = "w1";

// The bash tool calls the same service for a user, an API key or a run. A user
// keeps the test free of the agent and run rows a run's events point at.
const agent: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let ops: LibraryOps;

const bash = (script: string) => runLibraryBash({ ops, script });

const skillRows = () =>
  db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.workspaceId, WORKSPACE))
    .all()
    .filter((row) => row.kind === "file")
    .map((row) => row.path);

beforeEach(() => {
  db = migrated();
  const service = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      db,
    }),
  });
  ops = {
    list: (dir) => service.list(agent, dir),
    mkdir: (path) => service.mkdir(agent, path),
    move: (from, to) => service.move(agent, from, to),
    read: (path) => service.read(agent, path),
    remove: (path, options) => service.remove(agent, path, options),
    stat: (path) => service.stat(agent, path),
    write: (path, content, options) =>
      service.write(agent, path, content, options),
  };
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: "2026-10-16T10:00:00.000Z",
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
});

const skillScript = (folder: string, frontmatter: string) =>
  `mkdir -p skills/a1/${folder}
cat > skills/a1/${folder}/SKILL.md <<'EOF'
---
${frontmatter}
---
Shout.
EOF`;

const VALID = skillScript(
  "shout",
  "name: shout\ndescription: Answer in capitals."
);

test("an agent writes a valid skill with bash and edits it", async () => {
  const created = await bash(VALID);
  expect(created.exitCode).toBe(0);
  expect(skillRows()).toEqual(["skills/a1/shout/SKILL.md"]);

  const edited = await bash(
    "sed -i 's/capitals/capital letters/' skills/a1/shout/SKILL.md && cat skills/a1/shout/SKILL.md"
  );
  expect(edited.exitCode).toBe(0);
  expect(edited.stdout).toContain("capital letters");
});

test("bash cannot write a SKILL.md without a description", async () => {
  const result = await bash(skillScript("shout", "name: shout"));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Frontmatter needs a description");
  expect(skillRows()).toEqual([]);
});

test("bash cannot write a SKILL.md whose name differs from its folder", async () => {
  const result = await bash(
    skillScript("shout", "name: yell\ndescription: Answer in capitals.")
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('must match the folder "shout"');
  expect(skillRows()).toEqual([]);
});

test("a bash edit that breaks a saved skill is refused and the file stays valid", async () => {
  await bash(VALID);
  const result = await bash(
    "sed -i 's/^name: shout/name: yell/' skills/a1/shout/SKILL.md"
  );
  expect(result.exitCode).not.toBe(0);
  // sed -i reports every failed write the same way, so only the exit code and
  // the untouched file show the refusal.
  const after = await bash("cat skills/a1/shout/SKILL.md");
  expect(after.stdout).toContain("name: shout");
});
