import { expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import { harness, page, principals } from "./test-harness.ts";

test("a person creates a private artifact outside a session", async () => {
  const { db, service } = harness();
  const result = await service.create(principals.owner, {
    files: page(),
    kind: "page",
    title: "Report",
  });
  expect(result.version).toBe(1);
  const [row] = db.select().from(artifacts).all();
  expect(row?.audience).toBe("private");
  expect(row?.ownerUserId).toBe("u1");
  expect(
    db
      .select()
      .from(events)
      .all()
      .map((e) => e.type)
  ).toEqual(["artifact.created", "artifact.published"]);
  const read = await service.readFile(principals.owner, {
    artifactId: result.artifactId,
  });
  expect(read.text).toBe("<h1>Hello</h1>");
});
