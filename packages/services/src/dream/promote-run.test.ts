import { expect, test } from "bun:test";
import { runs } from "@repo/db/schema/runs";
import { AGENT, WORKSPACE } from "../memory/test-world.ts";
import {
  type DreamWorld,
  defined,
  makeDreamWorld,
  quiet,
  SESSION,
} from "./test-dream.ts";

const title = "Summarize reports";
const seedRuns = (
  w: DreamWorld,
  batch: string,
  sessionId: string = SESSION.shared,
  name = "report-summary",
  noteKind = "work"
) => {
  const ids = [1, 2, 3].map((n) => `${batch}-${n}`);
  for (const id of ids) {
    w.db
      .insert(runs)
      .values({
        actorId: "trigger_1",
        actorKind: "trigger",
        agentId: AGENT,
        createdAt: w.clock.now().toISOString(),
        finishedAt: w.clock.now().toISOString(),
        id,
        inputText: "Summarize the report",
        resultText: "Read the report, then sent a summary.",
        sessionId,
        status: "done",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  w.setScript((call) => {
    if (call.kind === "extract") {
      return JSON.stringify({
        notes: [
          { evidence: ["e1"], kind: noteKind, text: `Note for ${batch}` },
        ],
      });
    }
    if (call.kind !== "promote") {
      return quiet(call);
    }
    return JSON.stringify({
      procedures: [
        {
          description: "Read reports and send summaries.",
          evidence: ids,
          name,
          steps: ["Read the report.", "Send the summary."],
          title,
        },
      ],
    });
  });
};

test("a dream files once, lists it in the diary, and never refiles after rejection", async () => {
  const w = makeDreamWorld();
  w.setRules({ learnLevel: "ask_first" });
  seedRuns(w, "first");
  const first = await w.dream.runNow(w.owner, AGENT);
  expect(first.status).toBe("done");
  expect(first.diary).toContain(`Proposed a skill: ${title}`);
  const proposal = defined((await w.skillsStore.proposals(w.owner))[0]);
  expect(proposal.author).toEqual({ id: AGENT, kind: "agent", runId: null });
  expect(proposal.message).toBe(title);
  seedRuns(w, "second");
  expect((await w.dream.runNow(w.owner, AGENT)).status).toBe("done");
  expect(await w.skillsStore.proposals(w.owner)).toHaveLength(1);
  await w.skillsStore.reject(w.owner, {
    skillId: proposal.skillId,
    version: 1,
  });
  seedRuns(w, "third");
  const third = await w.dream.runNow(w.owner, AGENT);
  expect(third.status).toBe("done");
  expect(await w.skillsStore.proposals(w.owner)).toEqual([]);
  expect(await w.skillsStore.list(w.owner)).toHaveLength(1);
  expect(
    w.calls.filter((call) => call.kind === "promote").at(-1)?.prompt
  ).toContain(title);
});

test("a procedure run in a private session is never proposed", async () => {
  const w = makeDreamWorld();
  w.setRules({ learnLevel: "quiet" });
  seedRuns(w, "private", SESSION.privateA);
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(await w.skillsStore.proposals(w.owner)).toHaveLength(0);
  expect(run.diary).not.toContain("Proposed a skill");
});

test("failure to file a skill leaves a successful memory plan stored", async () => {
  const w = makeDreamWorld();
  seedRuns(w, "failure");
  w.skillsStore.proposeForAgent = () =>
    Promise.reject(new Error("storage unavailable"));
  w.setScript((call) => {
    if (call.kind === "extract") {
      return JSON.stringify({
        notes: [{ evidence: ["e1"], kind: "work", text: "Reports go to Mia" }],
      });
    }
    if (call.kind === "promote") {
      return JSON.stringify({
        procedures: [
          {
            description: "Send report summaries.",
            evidence: ["failure-1", "failure-2", "failure-3"],
            name: "report-summary",
            steps: ["Read.", "Send."],
            title,
          },
        ],
      });
    }
    return quiet(call);
  });
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(run.counts.added).toBe(1);
  expect(
    (await w.service.list(w.owner, { agentId: AGENT })).map((note) => note.text)
  ).toContain("Reports go to Mia");
  expect(run.diary).not.toContain("Proposed a skill");
});

test("a failed promotion model call preserves failed-dream memory semantics", async () => {
  const w = makeDreamWorld((call) => {
    if (call.kind === "promote") {
      return null;
    }
    if (call.kind === "extract") {
      return JSON.stringify({
        notes: [{ evidence: ["e1"], kind: "work", text: "Reports go to Mia" }],
      });
    }
    return quiet(call);
  });
  w.say("Something happened");
  const before = await w.files();
  expect((await w.dream.runNow(w.owner, AGENT)).status).toBe("failed");
  expect(await w.files()).toEqual(before);
});

test("an approved procedure remains filed on a later dream", async () => {
  const w = makeDreamWorld();
  seedRuns(w, "approved-first");
  await w.dream.runNow(w.owner, AGENT);
  const proposal = defined((await w.skillsStore.proposals(w.owner))[0]);
  await w.skillsStore.approve(w.owner, {
    skillId: proposal.skillId,
    version: 1,
  });
  seedRuns(w, "approved-second");
  const later = await w.dream.runNow(w.owner, AGENT);
  expect(later.status).toBe("done");
  expect(later.diary).not.toContain("Proposed a skill");
  expect(await w.skillsStore.proposals(w.owner)).toEqual([]);
  expect(await w.skillsStore.list(w.owner)).toHaveLength(1);
});

test("a held memory batch does not hold its independent skill proposal", async () => {
  const w = makeDreamWorld();
  w.setRules({ learnLevel: "ask_first" });
  seedRuns(w, "held");
  w.setScript((call) => {
    if (call.kind === "extract") {
      return JSON.stringify({
        notes: [{ evidence: ["e1"], kind: "work", text: "Reports go to Mia" }],
      });
    }
    if (call.kind === "promote") {
      return JSON.stringify({
        procedures: [
          {
            description: "Send report summaries.",
            evidence: ["held-1", "held-2", "held-3"],
            name: "report-summary",
            steps: ["Read.", "Send."],
            title,
          },
        ],
      });
    }
    return quiet(call);
  });
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect((await w.dream.changes(w.owner, run.id))[0]?.status).toBe("held");
  expect(await w.skillsStore.proposals(w.owner)).toHaveLength(1);
  await w.dream.decide(w.owner, { decision: "reject", dreamRunId: run.id });
  expect(await w.skillsStore.proposals(w.owner)).toHaveLength(1);
});

test("a rejected skill proposal is not evidence for a note", async () => {
  const w = makeDreamWorld();
  seedRuns(w, "noise-first");
  await w.dream.runNow(w.owner, AGENT);
  const proposal = defined((await w.skillsStore.proposals(w.owner))[0]);
  await w.skillsStore.reject(w.owner, {
    skillId: proposal.skillId,
    version: 1,
  });
  seedRuns(w, "noise-second");
  await w.dream.runNow(w.owner, AGENT);
  const extract = w.calls.filter((call) => call.kind === "extract").at(-1);
  expect(extract?.prompt).toContain("task_result");
  expect(extract?.prompt).not.toContain("skill_proposal");
  expect(
    w.calls.filter((call) => call.kind === "promote").at(-1)?.prompt
  ).toContain("skill_proposal");
});

test("undoing a dream withdraws its skill proposal and leaves a later dream's alone", async () => {
  const w = makeDreamWorld();
  w.say("Something happened");
  seedRuns(w, "first", SESSION.shared, "first-skill");
  const first = await w.dream.runNow(w.owner, AGENT);
  seedRuns(w, "second", SESSION.shared, "second-skill", "people");
  const second = await w.dream.runNow(w.owner, AGENT);
  expect(first.diary).toContain("Proposed a skill");
  expect(await w.skillsStore.proposals(w.owner)).toHaveLength(2);

  await w.dream.undo(w.owner, first.id);

  const left = await w.skillsStore.proposals(w.owner);
  const names = (await w.skillsStore.list(w.owner)).filter((skill) =>
    left.some((version) => version.skillId === skill.id)
  );
  expect(names.map((skill) => skill.name)).toEqual(["second-skill"]);
  const assigned = await w.skillsStore.assignments(w.owner);
  expect(assigned.map((item) => item.skillId)).toEqual(
    left.map((version) => version.skillId)
  );
  expect(second.status).toBe("done");
});

test("undoing a dream keeps a skill proposal a person already approved", async () => {
  const w = makeDreamWorld();
  seedRuns(w, "only");
  const run = await w.dream.runNow(w.owner, AGENT);
  const proposal = defined((await w.skillsStore.proposals(w.owner))[0]);
  await w.skillsStore.approve(w.owner, {
    skillId: proposal.skillId,
    version: 1,
  });

  await w.dream.undo(w.owner, run.id);

  expect((await w.skillsStore.list(w.owner))[0]?.latestApprovedVersion).toBe(1);
  expect(await w.skillsStore.assignments(w.owner)).toHaveLength(1);
});
