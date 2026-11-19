import { expect, test } from "bun:test";
import { AGENT_TEMPLATE_IDS, ASK_LEVELS, VOICE_PRESETS } from "@repo/db/shared";
import { agentDraftSchema, type BuilderCatalog, reconcileDraft } from "./draft.ts";
import { templateDraft, templates } from "./templates.ts";

const catalog: BuilderCatalog = {
  agents: [], connectors: [], machines: [], runtimes: [], skills: [],
};

test("the eight template keys match the shared list", () => {
  expect(AGENT_TEMPLATE_IDS).toEqual([
    "inbox_triage", "meeting_follow_up", "lead_research", "invoice_filing",
    "weekly_report", "support_first_reply", "drive_tidy", "social_drafts",
  ]);
  expect(Object.keys(templates).sort()).toEqual([...AGENT_TEMPLATE_IDS].sort());
});

for (const id of AGENT_TEMPLATE_IDS) {
  test(`${id} is a complete template and a valid draft without connected apps`, () => {
    const template = templates[id];
    for (const text of [template.title, template.description, template.job]) {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain("—");
    }
    expect(template.remember.length).toBeGreaterThanOrEqual(2);
    expect(template.remember.length).toBeLessThanOrEqual(3);
    expect(template.remember.every((item) => item.trim().length > 0)).toBe(true);
    expect(VOICE_PRESETS).toContain(template.voice);
    expect(ASK_LEVELS).toContain(template.askLevel);
    expect(template.askLevel).not.toBe("custom");
    expect(template.apps.length).toBeGreaterThan(0);
    const { raw, notes } = templateDraft(id, catalog);
    expect(agentDraftSchema.parse(raw)).toEqual({
      does: template.description, handsTo: [], library: [], name: template.title,
      rules: [], runsOn: null, sampleInput: [], skills: [], startsOn: [],
      tools: [], voice: template.voice,
    });
    expect(notes).toContain(`Suggested job: ${template.job}`);
    for (const item of template.remember) {
      expect(notes).toContain(`Remember: ${item}`);
    }
    const labels = {
      rarely: "Ask rarely", outside: "Ask before it acts outside",
      everything: "Ask before everything", custom: "custom",
    };
    expect(notes).toContain(`Asks: ${labels[template.askLevel]}`);
    for (const app of template.apps) {
      expect(notes).toContain(`Works with the ${app} app once it is connected`);
    }
    expect(reconcileDraft(raw, catalog).gaps).toEqual([
      { field: "runs_on", question: "Where it runs" },
    ]);
  });
}

test("only connectors with a matching catalogue key become tools", () => {
  const choices: BuilderCatalog = {
    ...catalog,
    connectors: [
      { catalogKey: "gmail", description: "", id: "mail-1", name: "Mail", tools: [] },
      { catalogKey: "gmail", description: "", id: "mail-2", name: "Other mail", tools: [] },
      { catalogKey: "unrelated", description: "", id: "other", name: "Other", tools: [] },
      { description: "", id: "legacy", name: "google-calendar", tools: [] },
    ],
  };
  const { raw, notes } = templateDraft("meeting_follow_up", choices);
  expect(raw.tools).toEqual(["mail-1", "mail-2"]);
  expect(notes).not.toContain("Works with the gmail app once it is connected");
  expect(notes).toContain("Works with the google-calendar app once it is connected");
  expect(reconcileDraft(raw, choices).gaps).toEqual([
    { field: "runs_on", question: "Where it runs" },
  ]);
});
