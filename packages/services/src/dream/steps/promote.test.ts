import { expect, test } from "bun:test";
import type { DreamInput } from "../collect.ts";
import { promoteProcedures } from "./promote.ts";

const items: DreamInput[] = ["r1", "r2", "r3"].map((id) => ({
  createdAt: "2026-11-19T00:00:00.000Z",
  id,
  kind: "task_result",
  scope: "workspace",
  sourceId: id,
  sourceKind: "run",
  text: "Read the report, then send a summary.",
}));
const procedure = {
  description: "Read a report and send its summary.",
  evidence: ["r1", "r2", "r3"],
  name: "report-summary",
  steps: ["Read the report.", "Send its summary."],
  title: "Summarize reports",
};
const promote = (
  draft = procedure,
  rejected: string[] = [],
  existingNames: string[] = []
) =>
  promoteProcedures({
    existingNames,
    items,
    judge: () => Promise.resolve(JSON.stringify({ procedures: [draft] })),
    rejected,
  });

test("three distinct cited runs draft a valid skill", async () => {
  const drafts = await promote();
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.content).toContain("name: report-summary");
  expect(drafts[0]?.content).toContain("1. Read the report.");
});
test("two runs and repeated evidence do not qualify", async () => {
  expect(await promote({ ...procedure, evidence: ["r1", "r2", "r2"] })).toEqual(
    []
  );
});
test("invented ids do not count", async () => {
  expect(
    await promote({ ...procedure, evidence: ["r1", "r2", "invented"] })
  ).toEqual([]);
});
test("a normalized rejected title is skipped and supplied to the model", async () => {
  expect(await promote(procedure, ["  SUMMARIZE reports. "])).toEqual([]);
  let prompt = "";
  await promoteProcedures({
    existingNames: [],
    items,
    judge: (input) => {
      prompt = input;
      return Promise.resolve(null);
    },
    rejected: ["Summarize reports"],
  });
  expect(prompt).toContain("Summarize reports");
});
test("an already owned name is skipped", async () => {
  expect(await promote(procedure, [], [procedure.name])).toEqual([]);
});
test("null and unparseable judge answers draft nothing", async () => {
  for (const answer of [null, "not json"]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: exercise each failure answer independently
      await promoteProcedures({
        existingNames: [],
        items,
        judge: () => Promise.resolve(answer),
        rejected: [],
      })
    ).toEqual([]);
  }
});
test("invalid names and single-step procedures are skipped", async () => {
  expect(await promote({ ...procedure, name: "Bad Name" })).toEqual([]);
  expect(await promote({ ...procedure, steps: ["Just do it"] })).toEqual([]);
});
test("private evidence is never sent to the judge or cited", async () => {
  const prompts: string[] = [];
  const drafts = await promoteProcedures({
    existingNames: [],
    items: items.map((item) => ({ ...item, scope: "private", userId: "u1" })),
    judge: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(JSON.stringify({ procedures: [procedure] }));
    },
    rejected: [],
  });
  expect(drafts).toEqual([]);
  expect(prompts[0]).not.toContain("Read the report");
});
