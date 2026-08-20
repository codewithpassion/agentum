import { describe, expect, test } from "bun:test";
import type { AgentSkillAssignment } from "#/modules/skills/service";
import { MAX_AGENT_SKILLS } from "#/modules/skills/validate";
import { composeAgentSkills } from "./agent-skills";

/**
 * What reaches `agents.update`. Every case here is a way an assignment can fail
 * to be sendable - the payload must stay valid, and the reason must be visible.
 */

const NOT_MIRRORED = /not mirrored/;
const PIN_NOT_MIRRORED = /has not been mirrored/;
const OVER_CAP = /cap/;

const assignment = (
  overrides: Partial<AgentSkillAssignment> = {}
): AgentSkillAssignment => ({
  anthropicSkillId: "skill_01",
  pinnedAnthropicVersion: null,
  pinnedVersion: null,
  slug: "weekly-report",
  ...overrides,
});

describe("composeAgentSkills", () => {
  test("tracks latest with the literal marker the API stores", () => {
    // "latest" is resolved when a session is created, which is what makes a
    // published fix reach every tracking agent with no resync at all.
    expect(composeAgentSkills([assignment()]).skills).toEqual([
      { skillId: "skill_01", version: "latest" },
    ]);
  });

  test("sends a pin as that version's own Anthropic id", () => {
    expect(
      composeAgentSkills([
        assignment({
          pinnedAnthropicVersion: "1787195643170342",
          pinnedVersion: 1,
        }),
      ]).skills
    ).toEqual([{ skillId: "skill_01", version: "1787195643170342" }]);
  });

  test("skips a skill that has not been mirrored", () => {
    const composed = composeAgentSkills([
      assignment({ anthropicSkillId: null }),
    ]);

    expect(composed.skills).toEqual([]);
    expect(composed.dropped[0]?.reason).toMatch(NOT_MIRRORED);
  });

  test("skips a pin whose version was never mirrored, rather than falling back", () => {
    // Falling back to "latest" would hand the agent the very version the pin
    // exists to avoid.
    const composed = composeAgentSkills([
      assignment({ pinnedAnthropicVersion: null, pinnedVersion: 2 }),
    ]);

    expect(composed.skills).toEqual([]);
    expect(composed.dropped[0]?.reason).toMatch(PIN_NOT_MIRRORED);
  });

  test("clamps at the per-agent cap and reports the remainder", () => {
    const assignments = Array.from(
      { length: MAX_AGENT_SKILLS + 2 },
      (_, index) =>
        assignment({ anthropicSkillId: `skill_${index}`, slug: `s-${index}` })
    );

    const composed = composeAgentSkills(assignments);

    expect(composed.skills.length).toBe(MAX_AGENT_SKILLS);
    expect(composed.dropped.length).toBe(2);
    expect(composed.dropped[0]?.reason).toMatch(OVER_CAP);
  });
});
