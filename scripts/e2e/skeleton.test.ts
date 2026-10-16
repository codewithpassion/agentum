import { expect, test } from "bun:test";
import { INSTRUCTIONS, runSkeleton, SkeletonError, STEPS } from "./skeleton.ts";

const STEP_THREE = /step 3 \(the session resumed\)/;
const FAILED_RUN = /ended as failed: No claude binary/;

const harness = (replies: (string | { error: string; status: "failed" })[]) => {
  const out: string[] = [];
  const sent: string[] = [];
  let index = 0;
  return {
    deps: {
      createAgent: (instructions: string) => {
        out.push(`instructions: ${instructions}`);
        return Promise.resolve({ agentId: "agt_1", machineId: "mch_1" });
      },
      out: (line: string) => out.push(line),
      send: (_agent: string, _machine: string, text: string) => {
        sent.push(text);
        index += 1;
        return Promise.resolve(`run_${index}`);
      },
      wait: (runId: string) => {
        const reply = replies[Number(runId.slice(4)) - 1];
        return Promise.resolve(
          typeof reply === "object"
            ? { error: reply.error, resultText: null, status: reply.status }
            : { error: null, resultText: reply ?? "", status: "done" as const }
        );
      },
    },
    out,
    sent,
  };
};

test("the three prompts go out in order and a good run passes", async () => {
  const { deps, out, sent } = harness([
    "Pelican",
    "heron",
    "You asked for heron.",
  ]);
  await runSkeleton(deps);
  expect(sent).toEqual(STEPS.map((step) => step.prompt));
  expect(out).toContain("walking skeleton passed");
  expect(out[0]).toBe(`instructions: ${INSTRUCTIONS}`);
});

test("a reply without the name fails the first step and stops", async () => {
  const { deps, sent } = harness(["I am Claude", "heron", "heron"]);
  await expect(runSkeleton(deps)).rejects.toThrow(SkeletonError);
  expect(sent).toHaveLength(1);
});

test("a session that did not resume fails the third step", async () => {
  const { deps } = harness(["Pelican", "heron", "I do not remember."]);
  await expect(runSkeleton(deps)).rejects.toThrow(STEP_THREE);
});

test("a run that fails is reported with its error", async () => {
  const { deps } = harness([{ error: "No claude binary", status: "failed" }]);
  await expect(runSkeleton(deps)).rejects.toThrow(FAILED_RUN);
});
