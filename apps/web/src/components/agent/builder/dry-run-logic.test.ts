import { describe, expect, test } from "bun:test";
import type { ProfileGap } from "@repo/db/shared";
import type {
  AgentDraft,
  BuilderCatalog,
} from "@repo/services/agent-builder/draft";
import {
  addChip,
  cleanSample,
  createBlocker,
  draftSaveKey,
  dryRunRuntime,
  removeChip,
  type SampleChip,
  serverDraft,
  updateChip,
  wouldLines,
} from "./dry-run-logic.ts";

const sample: SampleChip[] = [
  { key: "from", value: "a@example.com" },
  { key: "subject", value: "Invoice" },
];

const draft: AgentDraft = {
  does: "Sorts the inbox.",
  handsTo: [],
  library: [],
  name: "Sorter",
  rules: [],
  runsOn: null,
  sampleInput: sample,
  skills: [],
  startsOn: [],
  tools: [],
  voice: "brief",
};

describe("chip edits", () => {
  test("updateChip patches only the chosen chip and returns a new array", () => {
    const next = updateChip(sample, 1, { value: "Receipt" });
    expect(next).toEqual([
      { key: "from", value: "a@example.com" },
      { key: "subject", value: "Receipt" },
    ]);
    expect(next).not.toBe(sample);
    expect(sample[1]).toEqual({ key: "subject", value: "Invoice" });
  });

  test("updateChip with an out-of-range index returns an unchanged copy", () => {
    const high = updateChip(sample, 2, { key: "x" });
    const low = updateChip(sample, -1, { key: "x" });
    expect(high).toEqual(sample);
    expect(low).toEqual(sample);
    expect(high).not.toBe(sample);
  });

  test("removeChip drops the chosen chip only", () => {
    expect(removeChip(sample, 0)).toEqual(sample.slice(1));
    expect(sample).toHaveLength(2);
  });

  test("removeChip with an out-of-range index returns an unchanged copy", () => {
    expect(removeChip(sample, 5)).toEqual(sample);
    expect(removeChip([], 0)).toEqual([]);
  });

  test("addChip appends a blank chip", () => {
    expect(addChip(sample)).toEqual([...sample, { key: "", value: "" }]);
    expect(addChip([])).toEqual([{ key: "", value: "" }]);
  });
});

describe("cleanSample", () => {
  test("trims keys and values", () => {
    expect(
      cleanSample([{ key: "  from ", value: " a@example.com  " }])
    ).toEqual([{ key: "from", value: "a@example.com" }]);
  });

  test("drops chips whose key is blank after trimming", () => {
    expect(
      cleanSample([
        { key: "", value: "orphan" },
        { key: "   ", value: "spaces" },
        { key: "subject", value: "  " },
      ])
    ).toEqual([{ key: "subject", value: "" }]);
  });

  test("keeps a blank value when the key is set", () => {
    expect(cleanSample([{ key: "k", value: "" }])).toEqual([
      { key: "k", value: "" },
    ]);
  });

  test("an empty sample stays empty", () => {
    expect(cleanSample([])).toEqual([]);
  });
});

describe("serverDraft and draftSaveKey", () => {
  test("serverDraft cleans only the sample", () => {
    const messy = {
      ...draft,
      sampleInput: [
        { key: " from ", value: " x " },
        { key: " ", value: "y" },
      ],
    };
    const sent = serverDraft(messy);
    expect(sent.sampleInput).toEqual([{ key: "from", value: "x" }]);
    expect(sent.name).toBe("Sorter");
    expect(messy.sampleInput).toHaveLength(2);
  });

  test("draftSaveKey ignores the sample", () => {
    const other = { ...draft, sampleInput: [] };
    expect(draftSaveKey(draft)).toBe(draftSaveKey(other));
  });

  test("draftSaveKey changes when any other field changes", () => {
    expect(draftSaveKey({ ...draft, name: "Mail" })).not.toBe(
      draftSaveKey(draft)
    );
    expect(JSON.parse(draftSaveKey(draft))).not.toHaveProperty("sampleInput");
  });
});

describe("createBlocker", () => {
  const address: ProfileGap = {
    field: "address",
    question: "What address?",
  };
  const runsOn: ProfileGap = { field: "runs_on", question: "Where it runs." };
  const tools: ProfileGap = { field: "tools", question: "Which tools?" };

  test("no gaps means no blocker", () => {
    expect(createBlocker([])).toBeNull();
  });

  test("an address-only gap does not block", () => {
    expect(createBlocker([address])).toBeNull();
  });

  test("other gaps block and their questions are joined", () => {
    expect(createBlocker([runsOn, tools])).toBe(
      "Decide first: Where it runs. Which tools?"
    );
  });

  test("address gaps are left out of a mixed list", () => {
    expect(createBlocker([address, tools])).toBe("Decide first: Which tools?");
  });
});

describe("wouldLines", () => {
  test("lists skipped tool calls in event order", () => {
    expect(
      wouldLines([
        {
          payload: { summary: "to a@example.com", tool: "mail.send" },
          type: "run.dry_run_skipped",
        },
        { payload: { tool: "x" }, type: "message.user" },
        {
          payload: { summary: "Invoice 42", tool: "ledger.post" },
          type: "run.dry_run_skipped",
        },
      ])
    ).toEqual([
      "Would call mail.send with to a@example.com",
      "Would call ledger.post with Invoice 42",
    ]);
  });

  test("skips skipped events whose payload is malformed", () => {
    expect(
      wouldLines([
        { payload: { tool: "mail.send" }, type: "run.dry_run_skipped" },
        { payload: { summary: "x" }, type: "run.dry_run_skipped" },
        {
          payload: { summary: 3, tool: "mail.send" },
          type: "run.dry_run_skipped",
        },
        {
          payload: { summary: "ok", tool: ["mail.send"] },
          type: "run.dry_run_skipped",
        },
        {
          payload: { summary: "kept", tool: "mail.send" },
          type: "run.dry_run_skipped",
        },
      ])
    ).toEqual(["Would call mail.send with kept"]);
  });

  test("an empty list gives no lines", () => {
    expect(wouldLines([])).toEqual([]);
  });
});

describe("dryRunRuntime", () => {
  const catalog = (runtimes: BuilderCatalog["runtimes"]): BuilderCatalog => ({
    agents: [],
    connectors: [],
    machines: [{ id: "m1", name: "Studio", online: true }],
    runtimes,
    skills: [],
  });

  test("says the dry run is on Cloudflare when that is the chosen runtime", () => {
    expect(
      dryRunRuntime(catalog(["managed", "cloud"]), { runtime: "cloud" })
    ).toEqual({
      blocker: null,
      note: "The dry run runs on Cloudflare, the runtime you chose.",
    });
  });

  test("says so when the chosen runtime cannot run a dry run", () => {
    const machine = dryRunRuntime(catalog(["machine", "cloud"]), {
      machineId: "m1",
      runtime: "machine",
    });
    expect(machine.blocker).toBeNull();
    expect(machine.note).toContain("Studio cannot run a dry run");
    expect(
      dryRunRuntime(catalog(["managed", "cloud"]), { runtime: "managed" }).note
    ).toContain("Anthropic cloud cannot run a dry run");
  });

  test("blocks the run, not Create, when there is no Anthropic key", () => {
    const result = dryRunRuntime(catalog(["machine"]), {
      machineId: "m1",
      runtime: "machine",
    });
    expect(result.blocker).toContain("Anthropic API key");
  });
});
