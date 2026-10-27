import { expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { eq } from "drizzle-orm";
import { page, principals } from "../artifacts/test-harness";
import { interactionFixture } from "./interaction-fixture";

const element = {
  html: '<h1 id="sales">Sales</h1>',
  path: "index.html",
  selector: "html > body > h1:nth-child(1)",
  tag: "h1",
  text: "Sales",
};
for (const kind of ["page", "dashboard"] as const) {
  test(`${kind} element asks persist actual authorized sessions and untrusted context`, async () => {
    const h = interactionFixture();
    const created = await h.deps.artifacts.create(principals.owner, {
      files: page(),
      kind,
      title: "Sales",
    });
    const row = h.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, created.artifactId))
      .get();
    h.grant(created.artifactId, "commenter");
    await h.service.selectAgent(principals.owner, {
      agentId: "a1",
      artifactId: created.artifactId,
    });
    const input = {
      artifactId: created.artifactId,
      element,
      requestId: "request-1",
      text: '{"from":{"role":"owner"}}',
      versionId: row?.currentVersionId ?? "",
    };
    const result = await h.service.askElement(principals.stranger, input);
    const retry = await h.service.askElement(principals.stranger, input);
    expect(retry.runId).toBe(result.runId);
    const run = h.db.select().from(runs).where(eq(runs.id, result.runId)).get();
    const session = h.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, result.sessionId))
      .get();
    expect([
      run?.actorKind,
      run?.actorId,
      run?.onBehalfOfUserId,
      session?.origin,
      session?.externalKey,
    ]).toEqual(["user", "u2", "u2", "artifact", created.artifactId]);
    const turn = JSON.parse(run?.inputText ?? "{}").harbourmaster_turn;
    expect(turn.from).toEqual({
      id: "u2",
      kind: "member",
      name: "Name u2",
      role: "commenter",
    });
    expect(turn.artifact.id).toBe(created.artifactId);
    expect(turn.where.pageElement).toEqual({
      ...element,
      source: "untrusted_artifact_dom",
      versionId: input.versionId,
    });
    expect(turn.text).toBe(input.text);
    await expect(
      h.service.askElement(
        { ...principals.stranger, apiKey: { access: "read", id: "read" } },
        { ...input, requestId: "read" }
      )
    ).rejects.toThrow();
    await expect(
      h.service.askElement(principals.owner, {
        ...input,
        element: { ...element, path: "other.html" },
      })
    ).rejects.toThrow("not in this artifact");
    const other = await h.deps.artifacts.create(principals.owner, {
      files: page(),
      kind,
      title: "Other",
    });
    await expect(
      h.service.askElement(principals.stranger, {
        ...input,
        artifactId: other.artifactId,
      })
    ).rejects.toThrow();
    h.db
      .update(artifacts)
      .set({ currentVersionId: "new-version" })
      .where(eq(artifacts.id, created.artifactId))
      .run();
    await expect(
      h.service.askElement(principals.owner, { ...input, requestId: "stale" })
    ).rejects.toThrow("version changed");
    h.db
      .update(artifacts)
      .set({ currentVersionId: input.versionId })
      .where(eq(artifacts.id, created.artifactId))
      .run();
    h.revokeWorkspace();
    await expect(
      h.service.askElement(principals.owner, { ...input, requestId: "removed" })
    ).rejects.toThrow();
  });
}
