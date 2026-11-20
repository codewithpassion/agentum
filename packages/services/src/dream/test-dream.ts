// The dream's test world: the memory world plus a dream service whose model is
// a script. For the dream tests only.
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { eq } from "drizzle-orm";
import { createDreamService } from "../dream.ts";
import { createEventsService } from "../events.ts";
import {
  AGENT,
  RUN as BASE_RUN,
  SESSION as BASE_SESSION,
  makeWorld,
  OWNER,
  person,
  USER_A,
  WORKSPACE,
  type World,
} from "../memory/test-world.ts";
import type { Clock } from "../runs/types.ts";
import { memorySkillBlobs } from "../skills-store/memory.ts";
import { createSkillsStoreService } from "../skills-store.ts";

export const SESSION = { ...BASE_SESSION, shared: "s_shared" } as const;
export const RUN = { ...BASE_RUN, shared: "r_shared" } as const;

/** A value the test knows is there, narrowed without a conditional the linter calls unnecessary. */
export const defined = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a value");
  }
  return value;
};

export type CallKind =
  | "condense"
  | "extract"
  | "finished"
  | "promote"
  | "merge"
  | "reconcile";

export interface Call {
  kind: CallKind;
  prompt: string;
}

/** What the fake model answers for one call. `null` is a failed request. */
export type Script = (call: Call) => string | null | Promise<string | null>;

const kindOf = (system: string): CallKind => {
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

/** The default answer: nothing to keep, merge, settle or prune. */
export const quiet: Script = ({ kind }) => {
  if (kind === "extract") {
    return JSON.stringify({ notes: [] });
  }
  if (kind === "merge") {
    return JSON.stringify({ groups: [] });
  }
  if (kind === "reconcile") {
    return JSON.stringify({ conflicts: [] });
  }
  if (kind === "finished") {
    return JSON.stringify({ finished: [] });
  }
  return JSON.stringify({ groups: [] });
};

export const makeDreamWorld = (initial: Script = quiet, dreamClock?: Clock) => {
  const world: World = makeWorld();
  let script = initial;
  const calls: Call[] = [];
  const blobs = new Map<string, string>();
  const eventsService = createEventsService({
    blobs: {
      get: (name) => Promise.resolve(blobs.get(name) ?? null),
      put: (name, body) => {
        blobs.set(name, body);
        return Promise.resolve();
      },
    },
    db: world.db,
  });
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: [{ content: string }];
      system: string;
    };
    const call: Call = {
      kind: kindOf(body.system),
      prompt: body.messages[0].content,
    };
    calls.push(call);
    return Promise.resolve(script(call)).then((answer) =>
      answer === null
        ? new Response("{}", { status: 500 })
        : Response.json({
            content: [{ text: answer, type: "text" }],
            usage: { input_tokens: 100, output_tokens: 20 },
          })
    );
  };
  const skillsStore = createSkillsStoreService({
    atomic: world.atomic,
    blobs: memorySkillBlobs(),
    clock: world.clock,
    db: world.db,
    events: eventsService,
    library: world.library,
  });
  let key: string | null = "sk-ant-test";
  const dream = createDreamService({
    atomic: world.atomic,
    clock: dreamClock ?? world.clock,
    db: world.db,
    events: eventsService,
    fetch,
    library: world.library,
    managedKeys: {
      resolve: () =>
        Promise.resolve(key ? { apiKey: key, environmentId: null } : null),
    },
    memory: world.service,
    skillsStore,
  });

  // A conversation that is nobody's private one: a UI session is tagged to its person, a trigger's is not.
  const seededAt = new Date(0).toISOString();
  world.db
    .insert(sessions)
    .values({
      actorId: "trigger_1",
      actorKind: "trigger",
      agentId: AGENT,
      createdAt: seededAt,
      id: SESSION.shared,
      origin: "trigger",
      private: false,
      workspaceId: WORKSPACE,
    })
    .run();
  world.db
    .insert(runs)
    .values({
      actorId: "trigger_1",
      actorKind: "trigger",
      agentId: AGENT,
      createdAt: seededAt,
      id: RUN.shared,
      inputText: "hi",
      onBehalfOfUserId: null,
      sessionId: SESSION.shared,
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();

  const runIdOf: Record<string, string> = {
    [SESSION.mail]: RUN.mail,
    [SESSION.privateA]: RUN.privateA,
    [SESSION.privateB]: RUN.privateB,
    [SESSION.shared]: RUN.shared,
  };
  let messages = 0;
  /** Evidence: a message. By default in a shared session, so a note it yields is shared too. */
  const say = (text: string, sessionId: string = SESSION.shared) => {
    messages += 1;
    world.db
      .insert(events)
      .values({
        actorId: USER_A,
        actorKind: "user",
        agentId: AGENT,
        createdAt: world.clock.now().toISOString(),
        id: `ev_dream_${messages}`,
        payload: JSON.stringify({ text }),
        runId: runIdOf[sessionId] ?? RUN.ui,
        sessionId,
        type: "message.user",
        workspaceId: WORKSPACE,
      })
      .run();
  };

  const owner = person(OWNER, { isAdmin: true });

  const setRules = (rules: Record<string, unknown>) =>
    world.db
      .update(agents)
      .set({
        remember: JSON.stringify({
          dreamSchedule: "nightly",
          learnLevel: "tell_after",
          never: [],
          remember: [],
          shareWithTeam: true,
          ...rules,
        }),
      })
      .where(eq(agents.id, AGENT))
      .run();

  /** Every memory file's text, by path, for the agent. */
  const files = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const principal = person(OWNER);
    const paths = [
      "people.md",
      "corrections.md",
      "work.md",
      "places.md",
      "index.md",
    ];
    for (const path of paths) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: five small reads, in order
        const { bytes } = await world.library.read(
          principal,
          `agents/scout/memory/${path}`
        );
        out[path] = new TextDecoder().decode(bytes);
      } catch {
        // The file does not exist yet.
      }
    }
    return out;
  };

  return {
    ...world,
    calls,
    dream,
    files,
    owner,
    say,
    setKey: (next: string | null) => {
      key = next;
    },
    setRules,
    setScript: (next: Script) => {
      script = next;
    },
    skillsStore,
  };
};

export type DreamWorld = ReturnType<typeof makeDreamWorld>;
