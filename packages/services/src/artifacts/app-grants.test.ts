import { expect, test } from "bun:test";
import { artifacts, artifactVersions } from "@repo/db/schema/artifacts";
import { eq } from "drizzle-orm";
import { systemClock } from "../runs/types.ts";
import { createArtifactGrantsService, type ToolCatalog } from "./grants.ts";
import { createArtifactsService } from "./service.ts";
import { harness, principals } from "./test-harness.ts";

const READ_ONLY: Record<string, boolean> = {
  "linear/get_issue": true,
  "linear/list_issues": true,
  "linear/save_issue": false,
};
const catalog: ToolCatalog = {
  lookup: (_workspaceId, key) =>
    Promise.resolve(
      key in READ_ONLY ? { readOnly: READ_ONLY[key] === true } : null
    ),
};

const setup = () => {
  const h = harness();
  const grants = createArtifactGrantsService({
    atomic: h.atomic,
    clock: systemClock,
    db: h.db,
    events: h.events,
    // A promote by a person never opens a card, so the requests port is not reached.
    requests: {
      answer: () => Promise.reject(new Error("not used")),
      open: () => Promise.reject(new Error("not used")),
    },
    tools: catalog,
  });
  const service = createArtifactsService({
    atomic: h.atomic,
    blobs: h.blobs,
    clock: systemClock,
    db: h.db,
    events: h.events,
    grants,
    library: h.library,
  });
  return { ...h, grants, service };
};

const app = (manifest: object) => [
  { path: "index.html", text: "<p>app</p>" },
  { path: "server/index.js", text: "export default {}" },
  { path: "agentum.json", text: JSON.stringify(manifest) },
];

const grantsOf = async (
  grants: ReturnType<typeof setup>["grants"],
  artifactId: string,
  versionId: string
) =>
  (await grants.list(principals.owner, { artifactId, versionId })).map(
    (grant) => [grant.kind, grant.target, grant.status]
  );

test("a person's app goes live at once with its grants approved", async () => {
  const { db, grants, service } = setup();
  const made = await service.create(principals.owner, {
    files: app({
      hosts: ["api.example.com"],
      tools: [{ tool: "linear/get_issue" }],
    }),
    kind: "app",
    title: "Intake",
  });
  const [row] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, made.artifactId));
  expect(row?.currentVersionId).toBe(made.versionId);
  const [version] = await db.select().from(artifactVersions);
  expect(version?.status).toBe("published");
  expect(await grantsOf(grants, made.artifactId, made.versionId)).toEqual([
    ["host", "api.example.com", "approved"],
    ["tool", "linear/get_issue", "approved"],
  ]);
});

test("R2.4: an agent's app starts proposed with pending grants and no live version", async () => {
  const { db, grants, service } = setup();
  const made = await service.create(principals.agentOne, {
    files: app({ hosts: ["api.example.com"] }),
    kind: "app",
    title: "Intake",
  });
  const [row] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, made.artifactId));
  expect(row?.currentVersionId).toBeNull();
  const [version] = await db.select().from(artifactVersions);
  expect(version?.status).toBe("proposed");
  expect(await grantsOf(grants, made.artifactId, made.versionId)).toEqual([
    ["host", "api.example.com", "pending"],
  ]);
  await expect(
    grants.promote(principals.owner, {
      artifactId: made.artifactId,
      versionId: made.versionId,
    })
  ).rejects.toMatchObject({ code: "conflict" });
});

test("an agent's app that asks for nothing promotes at once, and its update builds on the newest version", async () => {
  const { db, grants, service } = setup();
  const made = await service.create(principals.agentOne, {
    files: app({}),
    kind: "app",
    title: "Intake",
  });
  expect(
    await grants.promote(principals.owner, {
      artifactId: made.artifactId,
      versionId: made.versionId,
    })
  ).toEqual({ status: "promoted", version: 1 });
  // The agent adds a host: version 2 is proposed, the live version stays 1.
  const next = await service.update(principals.agentOne, {
    artifactId: made.artifactId,
    baseVersion: 1,
    files: app({ hosts: ["files.example.com"] }),
  });
  const [row] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, made.artifactId));
  expect(row?.currentVersionId).toBe(made.versionId);
  expect(await grantsOf(grants, made.artifactId, next.versionId)).toEqual([
    ["host", "files.example.com", "pending"],
  ]);
  // A third version that adds nothing beyond version 1's approved set needs no one.
  const third = await service.update(principals.agentOne, {
    artifactId: made.artifactId,
    baseVersion: 1,
    files: app({}),
  });
  expect(
    await grants.promote(principals.owner, {
      artifactId: made.artifactId,
      versionId: third.versionId,
    })
  ).toEqual({ status: "promoted", version: 3 });
});

test("an app that asks for a write tool, an unknown tool or a bad manifest is never written", async () => {
  const { db, service } = setup();
  const manifests = [
    { tools: [{ tool: "linear/save_issue" }] },
    { tools: [{ tool: "nope/missing" }] },
    { hosts: ["HTTP://x"] },
  ];
  await Promise.all(
    manifests.map((manifest) =>
      expect(
        service.create(principals.owner, {
          files: app(manifest),
          kind: "app",
          title: "Bad",
        })
      ).rejects.toMatchObject({ code: "invalid" })
    )
  );
  expect(await db.select().from(artifacts)).toHaveLength(0);
  expect(await db.select().from(artifactVersions)).toHaveLength(0);
});

test("without the grants service an app is refused", async () => {
  const h = harness();
  await expect(
    h.service.create(principals.owner, {
      files: app({}),
      kind: "app",
      title: "No grants",
    })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("restoring an app version records its grants, and an unpromoted app updates from its newest version", async () => {
  const { db, grants, service } = setup();
  const made = await service.create(principals.owner, {
    files: app({ hosts: ["api.example.com"] }),
    kind: "app",
    title: "Intake",
  });
  await service.update(principals.owner, {
    artifactId: made.artifactId,
    baseVersion: 1,
    files: app({}),
  });
  const { version } = await service.restore(
    principals.owner,
    made.artifactId,
    1
  );
  expect(version).toBe(3);
  const [row] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, made.artifactId));
  expect(
    await grantsOf(grants, made.artifactId, row?.currentVersionId as string)
  ).toEqual([["host", "api.example.com", "approved"]]);

  // An agent's app with no promoted version builds on its newest version.
  const fresh = await service.create(principals.agentOne, {
    files: app({}),
    kind: "app",
    title: "Second",
  });
  const next = await service.update(principals.agentOne, {
    artifactId: fresh.artifactId,
    baseVersion: 1,
    files: app({}),
  });
  expect(next.version).toBe(2);
  await expect(
    service.update(principals.agentOne, {
      artifactId: fresh.artifactId,
      baseVersion: 1,
      files: app({}),
    })
  ).rejects.toMatchObject({ code: "conflict" });
});
