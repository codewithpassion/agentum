import { expect, test } from "bun:test";
import { PROFILE_FIELDS } from "@repo/db/shared";
import {
  type AgentDraft,
  agentDraftSchema,
  type BuilderCatalog,
  reconcileDraft,
} from "./draft.ts";

const catalog: BuilderCatalog = {
  agents: [{ does: "Review results", id: "reviewer", name: "Reviewer" }],
  connectors: [
    {
      description: "Read messages",
      id: "mail",
      name: "Mail",
      tools: [{ name: "read", readOnly: true }],
    },
  ],
  machines: [{ id: "laptop", name: "Laptop", online: false }],
  runtimes: ["cloud", "machine"],
  skills: [
    { description: "Summarize text", id: "summarize", name: "Summarize" },
  ],
};

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  does: "Sort messages",
  handsTo: [],
  library: [],
  name: "Inbox helper",
  rules: [],
  runsOn: { runtime: "cloud" },
  sampleInput: [],
  skills: [],
  startsOn: [],
  tools: [],
  voice: "brief",
  ...overrides,
});

test("unknown connector, skill and agent ids are removed and become profile gaps", () => {
  const result = reconcileDraft(
    draft({
      handsTo: ["reviewer", "Ghost"],
      skills: ["summarize", "Invented"],
      tools: ["mail", "Xero"],
    }),
    catalog,
    {}
  );
  expect(result.draft.tools).toEqual(["mail"]);
  expect(result.draft.skills).toEqual(["summarize"]);
  expect(result.draft.handsTo).toEqual(["reviewer"]);
  expect(result.gaps).toEqual([
    {
      field: "tools",
      question: "No connector for Xero yet. Add one or remove it",
    },
    {
      field: "skills",
      question: "No skill for Invented yet. Add one or remove it",
    },
    {
      field: "hands_to",
      question: "No agent for Ghost yet. Add one or remove it",
    },
  ]);
  for (const gap of result.gaps) {
    expect(PROFILE_FIELDS).toContain(gap.field);
  }
  for (const unknown of ["Xero", "Invented", "Ghost"]) {
    expect(result.didList.join(" ")).not.toContain(unknown);
  }
});

test("all edited fields survive a redraft, including empty and null values", () => {
  const locked = draft({
    does: "My task",
    handsTo: ["reviewer"],
    library: ["wiki"],
    name: "Mine",
    rules: ["Ask first"],
    runsOn: null,
    sampleInput: [{ key: "subject", value: "Hello" }],
    skills: ["summarize"],
    startsOn: [{ kind: "mail" }],
    tools: ["mail"],
    voice: "formal",
  });
  const result = reconcileDraft(draft(), catalog, locked);
  expect(result.draft).toEqual(locked);
  expect(result.gaps).toEqual([
    { field: "runs_on", question: "Where it runs" },
  ]);
});

test("locked unknown selections are preserved but still flagged", () => {
  const result = reconcileDraft(draft(), catalog, { tools: ["Xero"] });
  expect(result.draft.tools).toEqual(["Xero"]);
  expect(result.gaps[0]?.field).toBe("tools");
  expect(result.didList.join(" ")).not.toContain("Xero");
});

test("unset and unavailable runtimes and unknown machines become gaps", () => {
  for (const runsOn of [
    null,
    { runtime: "managed" },
    { runtime: "machine" },
    { machineId: "missing", runtime: "machine" },
  ] as const) {
    const result = reconcileDraft(draft({ runsOn }), catalog, {});
    expect(result.draft.runsOn).toBeNull();
    expect(result.gaps).toEqual([
      { field: "runs_on", question: "Where it runs" },
    ]);
  }
  expect(
    reconcileDraft(
      draft({ runsOn: { machineId: "laptop", runtime: "machine" } }),
      { ...catalog, runtimes: [] },
      {}
    ).gaps[0]?.field
  ).toBe("runs_on");
});

test("bad crons become gaps and are removed from unlocked starts", () => {
  const startsOn: AgentDraft["startsOn"] = [
    { cron: "bad", kind: "routine", label: "Daily", prompt: "Sort" },
    { kind: "slack_mention" },
  ];
  const result = reconcileDraft(draft({ startsOn }), catalog, {});
  expect(result.draft.startsOn).toEqual([{ kind: "slack_mention" }]);
  expect(result.gaps[0]?.field).toBe("starts_on");
  expect(result.didList.join(" ")).not.toContain("Daily");
  expect(reconcileDraft(draft(), catalog, { startsOn }).draft.startsOn).toEqual(
    startsOn
  );
});

test("offline machines are notes, mail remains a future start, and neither is a gap", () => {
  const result = reconcileDraft(
    draft({
      runsOn: { machineId: "laptop", runtime: "machine" },
      startsOn: [{ kind: "mail" }],
    }),
    catalog,
    {}
  );
  expect(result.gaps).toEqual([]);
  expect(result.draft.runsOn).toEqual({
    machineId: "laptop",
    runtime: "machine",
  });
  expect(result.didList).toContain("Laptop is offline");
  expect(result.didList).toContain(
    "Mail starts it once the inbox arrives (V5)"
  );
});

test("routine prompt defaults to label and timezone stays optional", () => {
  const result = agentDraftSchema.parse({
    ...draft(),
    startsOn: [{ cron: "0 9 * * *", kind: "routine", label: "Daily" }],
  });
  expect(result.startsOn).toEqual([
    { cron: "0 9 * * *", kind: "routine", label: "Daily", prompt: "Daily" },
  ]);
  expect(
    agentDraftSchema.safeParse(draft({ runsOn: { runtime: "fake" } as never }))
      .success
  ).toBe(false);
});

test("didList describes only the reconciled draft and reflects edits", () => {
  const result = reconcileDraft(draft({ tools: ["Xero"] }), catalog, {
    handsTo: ["reviewer"],
    library: ["wiki"],
    name: "My helper",
    rules: ["Ask first"],
    sampleInput: [{ key: "topic", value: "Bun" }],
    skills: ["summarize"],
    startsOn: [
      { cron: "0 9 * * *", kind: "routine", label: "Daily", prompt: "Sort" },
    ],
    tools: ["mail"],
  });
  expect(result.didList).toEqual([
    "Named it My helper",
    "Does: Sort messages",
    "Voice: brief",
    "Rule: Ask first",
    "Uses connector Mail",
    "Uses skill Summarize",
    "Hands to Reviewer",
    "Starts on Daily (0 9 * * *)",
    "Runs on cloud",
    "Uses library path wiki",
    "Sample input topic: Bun",
  ]);
});

test("available managed runtime and an online machine have no gaps or offline notes", () => {
  const available: BuilderCatalog = {
    ...catalog,
    machines: [{ id: "laptop", name: "Laptop", online: true }],
    runtimes: ["managed", "machine"],
  };
  for (const runsOn of [
    { runtime: "managed" },
    { machineId: "laptop", runtime: "machine" },
  ] as const) {
    const result = reconcileDraft(draft({ runsOn }), available, {});
    expect(result.draft.runsOn).toEqual(runsOn);
    expect(result.gaps).toEqual([]);
    expect(result.didList).not.toContain("Laptop is offline");
  }
});

test("reconciliation does not mutate its inputs and returns a schema-valid draft", () => {
  const raw = draft({ tools: ["Xero"] });
  const locked = { skills: ["summarize"] };
  const before = structuredClone({ catalog, locked, raw });
  const result = reconcileDraft(raw, catalog, locked);
  expect({ catalog, locked, raw }).toEqual(before);
  expect(agentDraftSchema.safeParse(result.draft).success).toBe(true);
});

test("malformed draft structure is rejected", () => {
  for (const raw of [
    null,
    [],
    { ...draft(), voice: "invented" },
    { ...draft(), sampleInput: ["text"] },
  ]) {
    expect(() => reconcileDraft(raw, catalog, {})).toThrow();
  }
});

test("a locked key set to undefined does not overwrite the model's value", () => {
  const result = reconcileDraft(draft(), catalog, {
    name: undefined,
  } as Partial<AgentDraft>);
  expect(result.draft.name).toBe("Inbox helper");
});
