import type { AgentRecord } from "./agents.ts";

/** The profile's instructions, voice, and currently available handoff targets. */
export const agentPrompt = (
  agent: Pick<AgentRecord, "instructions" | "soul" | "handsTo">,
  handsToNames: readonly string[]
): string =>
  [
    agent.instructions,
    agent.soul === "" ? "" : `## Voice\n${agent.soul}`,
    // A configured list with no active targets should not advertise a handoff.
    agent.handsTo.length > 0 && handsToNames.length > 0
      ? `You can hand work to: ${handsToNames.join(", ")} (use send_message)`
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
