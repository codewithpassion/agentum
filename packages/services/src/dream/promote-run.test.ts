import { expect, test } from "bun:test";
import { runs } from "@repo/db/schema/runs";
import { AGENT, WORKSPACE } from "../memory/test-world.ts";
import { defined, makeDreamWorld, quiet, SESSION, type DreamWorld } from "./test-dream.ts";

const title = "Summarize reports";
const seedRuns = (w: DreamWorld, batch: string, sessionId: string = SESSION.shared) => {
  const ids = [1, 2, 3].map((n) => `${batch}-${n}`);
  for (const id of ids) {
    w.db.insert(runs).values({
      actorId: "trigger_1", actorKind: "trigger", agentId: AGENT,
      createdAt: w.clock.now().toISOString(), finishedAt: w.clock.now().toISOString(),
      id, inputText: "Summarize the report", resultText: "Read the report, then sent a summary.",
      sessionId, status: "done", workspaceId: WORKSPACE,
    }).run();
  }
  w.setScript((call) => call.kind === "promote" ? JSON.stringify({ procedures: [{
    description: "Read reports and send summaries.", evidence: ids, name: "report-summary",
    steps: ["Read the report.", "Send the summary."], title,
  }] }) : quiet(call));
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
  await w.skillsStore.reject(w.owner, { skillId: proposal.skillId, version: 1 });
  seedRuns(w, "third");
  const third = await w.dream.runNow(w.owner, AGENT);
  expect(third.status).toBe("done");
  expect(await w.skillsStore.proposals(w.owner)).toEqual([]);
  expect(await w.skillsStore.list(w.owner)).toHaveLength(1);
  expect(w.calls.filter((call) => call.kind === "promote").at(-1)?.prompt).toContain(title);
});

test("private procedure evidence supplies only a generic diary line", async () => {
  const w = makeDreamWorld();
  w.setRules({ learnLevel: "quiet" });
  seedRuns(w, "private", SESSION.privateA);
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(await w.skillsStore.proposals(w.owner)).toHaveLength(1);
  expect(run.diary).toContain("Proposed a skill.");
  expect(run.diary).not.toContain(title);
});

test("failure to file a skill leaves a successful memory plan stored", async () => {
  const w = makeDreamWorld();
  seedRuns(w, "failure");
  w.skillsStore.proposeForAgent = () => Promise.reject(new Error("storage unavailable"));
  w.setScript((call) => {
    if (call.kind === "extract") {
      return JSON.stringify({ notes: [{ evidence: ["e1"], kind: "work", text: "Reports go to Mia" }] });
    }
    if (call.kind === "promote") {
      return JSON.stringify({ procedures: [{ description: "Send report summaries.", evidence: ["failure-1", "failure-2", "failure-3"], name: "report-summary", steps: ["Read.", "Send."], title }] });
    }
    return quiet(call);
  });
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(run.counts.added).toBe(1);
  expect((await w.service.list(w.owner, { agentId: AGENT })).map((note) => note.text)).toContain("Reports go to Mia");
  expect(run.diary).not.toContain("Proposed a skill");
});

test("a failed promotion model call preserves failed-dream memory semantics", async () => {
  const w = makeDreamWorld((call) => call.kind === "promote" ? null : quiet(call));
  w.say("Something happened");
  const before = await w.files();
  expect((await w.dream.runNow(w.owner, AGENT)).status).toBe("failed");
  expect(await w.files()).toEqual(before);
});
