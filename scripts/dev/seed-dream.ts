#!/usr/bin/env bun
// Seeds Slack conversations for an agent in the local database that `bun run
// dev` in apps/web uses, so Dream now has something to read. The sessions are
// shared, not private, so the notes the dream writes are workspace notes and
// their text shows in the diary. Progress goes to stderr, the count of
// conversations to stdout. Run from the repo root, after `seed-fake-agent.ts`:
// `bun scripts/dev/seed-dream.ts <agentId> [--owner <clerk user id>] [--set <1-4>] [--round <1|2>]`.
//
// Set 1 is ten conversations from the last nine days: one duplicate fact, one
// correction, one contradiction and a procedure the agent ran three times (a
// skill proposal). Set 2 is one neutral fact, a dream's reason to run when a
// walkthrough has added two disagreeing notes by hand (boardA and boardB) to
// get a question: a dream reconciles notes, and the model settles a conflict
// between two conversations by itself. Set 3 is two new facts and the procedure three more times (a
// batch to hold, and a skill that must not be filed again). Set 4 is two other
// new facts. Sets 2 to 4 are stamped just before now, so the next dream reads
// them. Round 2 swaps every name and time, so a second walkthrough (the phone
// one) meets fresh facts and a fresh procedure on the same agent, and stamps
// set 1 just before now too, because a dream reads only what is newer than the
// last one.
import { parseArgs } from "node:util";
import {
  D1_DIR,
  findLocalD1,
  LocalError,
  openSqlite,
  runCli,
} from "./local.ts";

const DAY_MS = 86_400_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const BASE = 32;
const NEW_SET_GAP_DAYS = 0.0001;
/** Round 2 squeezes set 1's days into a few seconds before now. */
const COMPRESS = 0.000_01;

/** A ULID at the given time. ulidx is not a dependency of the repo root. */
const ulid = (time: number): string => {
  let stamp = "";
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    stamp = `${CROCKFORD[rest % BASE]}${stamp}`;
    rest = Math.floor(rest / BASE);
  }
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_CHARS));
  return stamp + [...random].map((byte) => CROCKFORD[byte % BASE]).join("");
};

interface Chat {
  /** Days before now that the conversation happened. */
  ago: number;
  assistant: string;
  person: string;
  user: string;
}

interface Vocab {
  boardA: string;
  boardB: string;
  client: string;
  entities: readonly string[];
  eventFact: string;
  factA: string;
  factB: string;
  invoiceNew: string;
  invoiceOld: string;
  lunchNew: string;
  lunchOld: string;
  procedure: (entity: string) => { assistant: string; user: string };
  reportDay: string;
  spare: readonly [string, string];
}

const monthEnd = (entity: string) => ({
  assistant: `Month-end close for ${entity} is done. Step 1, exported the ledger from the finance sheet. Step 2, checked the totals against the bank statement (they matched). Step 3, posted the summary in #finance.`,
  user: `Please run the month-end close for ${entity}: export the ledger from the finance sheet, check the totals against the bank statement, then post the summary in #finance.`,
});

const onboarding = (person: string) => ({
  assistant: `Onboarding for ${person} is done. Step 1, created their accounts in the admin console. Step 2, sent the welcome pack. Step 3, booked the intro call with their manager.`,
  user: `Please onboard ${person}: create their accounts in the admin console, send the welcome pack, then book the intro call with their manager.`,
});

const VOCAB: Record<string, Vocab> = {
  "1": {
    boardA: "The board meets on the first Monday of every month.",
    boardB: "The board meets on the second Wednesday of each month.",
    client: "Northwind",
    entities: ["Harbour Ltd", "Harbour Pty", "Harbour Trust"],
    eventFact: "The all-hands is on the last Friday of the month.",
    factA: "Stand-up is at 9:15am every weekday.",
    factB: "The printer room is on level 2, next to the kitchen.",
    invoiceNew: "Fridays",
    invoiceOld: "Thursdays",
    lunchNew: "1:30pm",
    lunchOld: "1pm",
    procedure: monthEnd,
    reportDay: "Tuesday",
    spare: [
      "Visitors park in bay 12.",
      "The kitchen fridge is cleaned on Fridays.",
    ],
  },
  "2": {
    boardA: "The board meets on the first Tuesday of every month.",
    boardB: "The board meets on the third Thursday of each month.",
    client: "Contoso",
    entities: ["Dana Reyes", "Eli Parker", "Fay Nguyen"],
    eventFact: "The town hall is on the last Thursday of the month.",
    factA: "Stand-up is at 8:45am every weekday.",
    factB: "The server cupboard is on level 3, behind the lift.",
    invoiceNew: "Tuesdays",
    invoiceOld: "Mondays",
    lunchNew: "12:30pm",
    lunchOld: "12pm",
    procedure: onboarding,
    reportDay: "Wednesday",
    spare: [
      "Couriers deliver to the loading dock on Pine Street.",
      "The bike room code changes on the first of the month.",
    ],
  },
};

const chat = (
  ago: number,
  person: string,
  user: string,
  assistant: string
): Chat => ({ ago, assistant, person, user });

const setOne = (v: Vocab): Chat[] => {
  const [first, second, third] = v.entities.map(v.procedure);
  if (!(first && second && third)) {
    throw new LocalError("A procedure needs three entities");
  }
  return [
    chat(
      9,
      "U_ALEX",
      `For next time: the weekly sales report goes out every ${v.reportDay} morning.`,
      `Noted. The weekly sales report goes out every ${v.reportDay} morning.`
    ),
    chat(
      8,
      "U_ALEX",
      `Client lunches with ${v.client} are on ${v.lunchOld}.`,
      `Got it. Client lunches with ${v.client} are at ${v.lunchOld}.`
    ),
    chat(
      7,
      "U_SAM",
      `We pay supplier invoices on ${v.invoiceOld}.`,
      `Understood. Supplier invoices are paid on ${v.invoiceOld}.`
    ),
    chat(6, "U_PRIYA", first.user, first.assistant),
    chat(
      5,
      "U_ALEX",
      `The sales report is sent ${v.reportDay}s, first thing, to the leadership list.`,
      `Yes, the sales report is sent first thing on ${v.reportDay}s.`
    ),
    chat(
      4,
      "U_ALEX",
      `Correction: the ${v.client} lunch moved to ${v.lunchNew}. It is not ${v.lunchOld} any more.`,
      `Thanks for the correction. The ${v.client} lunch is now at ${v.lunchNew}.`
    ),
    chat(3, "U_PRIYA", second.user, second.assistant),
    chat(
      2,
      "U_SAM",
      `Supplier invoices are paid on ${v.invoiceNew}.`,
      `Noted. Supplier invoices are paid on ${v.invoiceNew}.`
    ),
    chat(
      1,
      "U_JO",
      "What is the weather like today?",
      "It is mild today, around 18 degrees."
    ),
    chat(0.5, "U_PRIYA", third.user, third.assistant),
  ];
};

const fact = (ago: number, person: string, text: string): Chat =>
  chat(ago, person, text, `Noted. ${text}`);

const setsOf = (v: Vocab): Record<string, Chat[]> => {
  const [first, second, third] = v.entities.map(v.procedure);
  if (!(first && second && third)) {
    throw new LocalError("A procedure needs three entities");
  }
  const gap = NEW_SET_GAP_DAYS;
  return {
    "1": setOne(v),
    "2": [
      fact(gap * 2, "U_JO", v.eventFact),
      chat(gap, "U_JO", "Thanks, that is all for now.", "You are welcome."),
    ],
    "3": [
      fact(gap * 5, "U_JO", v.factA),
      fact(gap * 4, "U_SAM", v.factB),
      chat(gap * 3, "U_PRIYA", first.user, first.assistant),
      chat(gap * 2, "U_PRIYA", second.user, second.assistant),
      chat(gap, "U_PRIYA", third.user, third.assistant),
    ],
    "4": [fact(gap * 2, "U_JO", v.spare[0]), fact(gap, "U_SAM", v.spare[1])],
  };
};

// biome-ignore lint/suspicious/useAwait: runCli takes an async main, and the script writes with bun:sqlite
export const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      owner: { type: "string" },
      round: { default: "1", type: "string" },
      set: { default: "1", type: "string" },
    },
  });
  const [agentId] = positionals;
  if (!agentId) {
    throw new LocalError(
      "Usage: bun scripts/dev/seed-dream.ts <agentId> [--owner <clerk user id>] [--set <1-4>] [--round <1|2>]"
    );
  }
  const vocab = VOCAB[values.round];
  const chats = vocab ? setsOf(vocab)[values.set] : undefined;
  if (!chats) {
    throw new LocalError("--set is 1 to 4 and --round is 1 or 2");
  }
  const file = findLocalD1(D1_DIR);
  if (!file) {
    throw new LocalError(`No local D1 database in ${D1_DIR}.`);
  }
  const client = openSqlite(file);
  let began = false;
  try {
    const agent = client
      .query<{ workspaceId: string }, [string]>(
        "SELECT workspace_id AS workspaceId FROM agents WHERE id = ?"
      )
      .get(agentId);
    if (!agent) {
      throw new LocalError(`No agent ${agentId} in the local database.`);
    }
    if (values.owner) {
      client
        .query("UPDATE agents SET owner_user_id = ? WHERE id = ?")
        .run(values.owner, agentId);
    }
    const now = Date.now();
    client.run("BEGIN");
    began = true;
    for (const [index, item] of chats.entries()) {
      const ago = values.round === "1" ? item.ago : item.ago * COMPRESS;
      const at = new Date(now - ago * DAY_MS);
      const iso = at.toISOString();
      const key = `dr7-r${values.round}-s${values.set}-${index + 1}`;
      const sessionId = ulid(at.getTime());
      const runId = ulid(at.getTime() + 1);
      client
        .query(
          `INSERT INTO sessions (id, workspace_id, agent_id, actor_kind, actor_id, origin, private, external_key, created_at, last_run_at)
           VALUES (?, ?, ?, 'user', ?, 'slack', 0, ?, ?, ?)`
        )
        .run(sessionId, agent.workspaceId, agentId, item.person, key, iso, iso);
      client
        .query(
          `INSERT INTO runs (id, workspace_id, agent_id, session_id, actor_kind, actor_id, input_text, status, result_text, created_at, started_at, finished_at)
           VALUES (?, ?, ?, ?, 'user', ?, ?, 'done', ?, ?, ?, ?)`
        )
        .run(
          runId,
          agent.workspaceId,
          agentId,
          sessionId,
          item.person,
          item.user,
          item.assistant,
          iso,
          iso,
          new Date(at.getTime() + 2000).toISOString()
        );
      const messages: [string, string, string, string][] = [
        ["message.user", "user", item.person, item.user],
        ["message.assistant", "agent", agentId, item.assistant],
      ];
      for (const [
        offset,
        [type, actorKind, actorId, text],
      ] of messages.entries()) {
        const when = new Date(at.getTime() + 1000 * (offset + 1));
        client
          .query(
            `INSERT INTO events (id, workspace_id, agent_id, session_id, run_id, type, actor_kind, actor_id, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            ulid(when.getTime()),
            agent.workspaceId,
            agentId,
            sessionId,
            runId,
            type,
            actorKind,
            actorId,
            JSON.stringify({ text }),
            when.toISOString()
          );
      }
    }
    client.run("COMMIT");
    process.stderr.write(`Seeded ${chats.length} conversations in ${file}.\n`);
    process.stdout.write(`${chats.length}\n`);
  } catch (error) {
    if (began) {
      client.run("ROLLBACK");
    }
    throw error;
  } finally {
    client.close();
  }
};

if (import.meta.main) {
  runCli(main);
}
