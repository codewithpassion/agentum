import { expect, test } from "bun:test";
import { AGENT_TEMPLATE_IDS, VOICE_PRESETS } from "@repo/db/shared";
import { agentDraftSchema } from "./draft.ts";
import { templates } from "./templates.ts";

test("every template has a title, starter description and valid draft voice", () => {
  expect(Object.keys(templates)).toEqual([...AGENT_TEMPLATE_IDS]);
  for (const id of AGENT_TEMPLATE_IDS) {
    const template = templates[id];
    expect(template.title.length).toBeGreaterThan(0);
    expect(template.description.length).toBeGreaterThan(0);
    expect(VOICE_PRESETS).toContain(template.voice);
    expect(
      agentDraftSchema.safeParse({
        does: template.description,
        handsTo: [],
        library: [],
        name: template.title,
        rules: [],
        runsOn: null,
        sampleInput: [],
        skills: [],
        startsOn: [],
        tools: [],
        voice: template.voice,
      }).success
    ).toBe(true);
  }
});
