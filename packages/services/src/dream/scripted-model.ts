// A dream's model on a dev build with no Anthropic key: a `fetch` that answers
// Anthropic's Messages API from a small fixture, so Dream now gives the same
// diary, question and held batch every time and costs nothing. It reports
// `usage` the way the real API does, so the spend caps see a dream's cost. The
// composition root uses it only when `devFakeRuntime` is on.
import type { Fetcher } from "../connectors/mcp.ts";
import type { DreamDeps } from "../dream.ts";
import type { ManagedKeysService } from "../managed/keys.ts";

export type CallKind =
  | "condense"
  | "extract"
  | "finished"
  | "promote"
  | "merge"
  | "reconcile"
  | "team_digest"
  | "team_friction"
  | "team_notes";

/** Which of the dream's calls a system prompt belongs to. */
export const kindOf = (system: string): CallKind => {
  if (system.includes("team-memory judge")) {
    return "team_notes";
  }
  if (system.includes("hand-off judge")) {
    return "team_friction";
  }
  if (system.includes("room digest for a team")) {
    return "team_digest";
  }
  if (system.includes("procedure-promotion judge")) {
    return "promote";
  }
  if (system.includes("memory of an AI agent")) {
    return "extract";
  }
  if (system.includes("more characters than the memory budget")) {
    return "condense";
  }
  if (system.includes("consolidation judge")) {
    return "merge";
  }
  if (system.includes("conflict judge")) {
    return "reconcile";
  }
  if (system.includes("hygiene judge") && system.includes("finished")) {
    return "finished";
  }
  return "condense";
};

/** The two notes every scripted dream keeps from the first evidence it reads. */
export const SCRIPTED_NOTES = [
  {
    kind: "work",
    text: "The quarterly planning review is on the first Friday of the quarter.",
  },
  {
    kind: "places",
    text: "Signed contracts are filed in the Legal folder on the shared drive.",
  },
] as const;

export const SCRIPTED_QUESTION =
  "These two notes disagree. Which one is right?";

/** How sure the scripted judge is that two notes conflict. Under the auto-apply floor, so a person decides. */
const SCRIPTED_CONFIDENCE = 0.5;

/** Tokens each scripted call reports. */
const SCRIPTED_INPUT_TOKENS = 120;
const SCRIPTED_OUTPUT_TOKENS = 40;

const EVIDENCE_LABEL = /^\[(e\d+)\]/gm;
const PERSON_NOTE = /^- id=(\S+) \(by person,/gm;

const labelsIn = (prompt: string, pattern: RegExp): string[] =>
  [...prompt.matchAll(pattern)].flatMap((match) => match[1] ?? []);

/** What the scripted model answers to one call. */
export const scriptedAnswer = (kind: CallKind, prompt: string): string => {
  if (kind === "extract") {
    const [first] = labelsIn(prompt, EVIDENCE_LABEL);
    return JSON.stringify({
      notes: first
        ? SCRIPTED_NOTES.map((note) => ({ ...note, evidence: [first] }))
        : [],
    });
  }
  if (kind === "reconcile") {
    // Two notes a person wrote disagree. A note the agent or a dream wrote never starts a question.
    const ids = labelsIn(prompt, PERSON_NOTE).slice(0, 2);
    return JSON.stringify({
      conflicts:
        ids.length === 2
          ? [
              {
                confidence: SCRIPTED_CONFIDENCE,
                ids,
                question: SCRIPTED_QUESTION,
                rationale: "The notes give different answers",
              },
            ]
          : [],
    });
  }
  if (kind === "finished") {
    return JSON.stringify({ finished: [] });
  }
  if (kind === "promote") {
    return JSON.stringify({ procedures: [] });
  }
  if (kind === "team_notes") {
    return JSON.stringify({ conflicts: [], shared: [] });
  }
  if (kind === "team_friction") {
    return JSON.stringify({ friction: [] });
  }
  if (kind === "team_digest") {
    return JSON.stringify({ digest: "" });
  }
  return JSON.stringify({ groups: [] });
};

interface MessagesRequest {
  messages: [{ content: string }];
  system: string;
}

/** A `fetch` that is Anthropic's Messages API, answered by `scriptedAnswer`. */
export const scriptedDreamFetch: Fetcher = (_url, init) => {
  const body = JSON.parse(String(init?.body)) as MessagesRequest;
  const answer = scriptedAnswer(kindOf(body.system), body.messages[0].content);
  return Promise.resolve(
    Response.json({
      content: [{ text: answer, type: "text" }],
      usage: {
        input_tokens: SCRIPTED_INPUT_TOKENS,
        output_tokens: SCRIPTED_OUTPUT_TOKENS,
      },
    })
  );
};

/** The key a dream run takes when it has none of its own: the scripted model reads no key, but the run wants one. */
const SCRIPTED_KEY = { apiKey: "scripted", environmentId: null } as const;

/**
 * The model side of the dream's dependencies. A dev build (`devFakeRuntime`) gets the scripted
 * model and a key to go with it, and calls out to nothing. Any other build gets what it was given.
 */
export const dreamModelDeps = (input: {
  devFakeRuntime: boolean;
  fetch: Fetcher;
  managedKeys: Pick<ManagedKeysService, "resolve">;
}): Pick<DreamDeps, "fetch" | "managedKeys"> => {
  const { devFakeRuntime, fetch, managedKeys } = input;
  if (!devFakeRuntime) {
    return { fetch, managedKeys };
  }
  return {
    fetch: scriptedDreamFetch,
    managedKeys: {
      resolve: async (workspaceId) =>
        (await managedKeys.resolve(workspaceId)) ?? SCRIPTED_KEY,
    },
  };
};
