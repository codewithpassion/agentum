// Regenerate from the repo root: bun apps/agentum/src/runs/parity.ts

import { taskFolderPath } from "@repo/db/shared";
import { workspaceInstructions } from "@repo/protocol/attachments";
import { createMasker } from "@repo/protocol/masker";
import {
  approvalSummary,
  askUserQuestionAnswers,
  outcomeText,
  toolKey,
} from "@repo/protocol/requests";
import { maxTurnsOf, stopMessage } from "@repo/protocol/safeguards";
import { write } from "bun";
import { createLibrarySync } from "../../../../packages/library-sync/src/index.ts";
import {
  createMemoryLocal,
  createMemoryManifest,
  createMemoryRemote,
  textOf,
} from "../../../../packages/library-sync/src/testing.ts";

const keys = [
  "Bash",
  "MultiEdit",
  "WebFetch",
  "mcp__a__b__Camel",
  "mcp__unknown__Tool",
  "Other",
].map((name) => ({
  expected: toolKey({ name, runtime: "machine", serverKeys: ["a", "a__b"] }),
  name,
  servers: ["a", "a__b"],
}));
const summaries = [
  { input: { command: "echo yes\nnext" }, name: "Bash" },
  { input: { peer: "Peer" }, name: "a2a_send" },
  { input: { peer: "Peer" }, name: "harbourmaster/send" },
  { input: { file_path: "notes" }, name: "Read" },
  { input: { query: "x".repeat(250) }, name: "Other" },
  { input: { command: "😀".repeat(120) }, name: "Bash" },
].map((item) => ({
  ...item,
  expected: approvalSummary(item.name, item.input),
}));
const outcomes = (["approval", "question", "takeover"] as const).flatMap(
  (kind) =>
    (["expired", "cancelled"] as const).map((status) => ({
      expected: outcomeText(kind, { status }),
      kind,
      outcome: { status },
    }))
);
const answered = (
  [
    {
      kind: "approval",
      outcome: { answer: { decision: "allow_once" }, status: "answered" },
    },
    {
      kind: "approval",
      outcome: { answer: { decision: "always_allow" }, status: "answered" },
    },
    {
      kind: "approval",
      outcome: {
        answer: { decision: "deny", note: "Please stop" },
        status: "answered",
      },
    },
    {
      kind: "question",
      outcome: {
        answer: { answers: { "Pick?": "yes", "Text?": "words" } },
        status: "answered",
      },
    },
    {
      kind: "takeover",
      outcome: { answer: { note: "Finished" }, status: "answered" },
    },
  ] as const
).map(({ kind, outcome }) => ({
  expected: outcomeText(kind, outcome),
  kind,
  outcome,
}));
const questions = {
  questions: [{ question: "Choose?" }, { question: "Text?" }],
};
const answer = {
  answers: { "Choose?": "a, b", "Text?": "free, text", unasked: "drop" },
};
const turns = [null, 9, 10, 100, 500, 501, 10.5, "12"].map((value) => ({
  expected: maxTurnsOf({ maxTurns: value }),
  value,
}));
const secrets = {
  KEY: "secret !'()~ with\nquote\"",
  PASSWORD: "password-with-more",
  TOKEN: "another-token",
};
const source = Object.values(secrets)
  .flatMap((value) => [
    value,
    JSON.stringify(value).slice(1, -1),
    btoa(value),
    btoa(`${value}\n`),
    encodeURIComponent(value),
    new URLSearchParams({ q: value }).toString().slice(2),
  ])
  .join("|");
const library = {
  conflicts: ["agents/ada/x.conflict-r"],
  paths: ["agents/ada"],
  roots: [{ mode: "write" as const, path: "agents/ada" }],
  taskFolder: "agents/ada/tasks/r",
};
const prompts = [false, true].map((live) => ({
  expected: workspaceInstructions({
    attachments: false,
    home: "/work",
    homeIsLocal: true,
    library: "/work/library",
    liveSync: live,
    scratch: { lasts: "run-start", path: "/work/tmp" },
    ...library,
    syncedPaths: library.paths,
    taskFolder: `/work/library/${library.taskFolder}`,
  }),
  library,
  live,
}));
const noLibraryPrompt = {
  expected: workspaceInstructions({
    attachments: false,
    home: "/work",
    homeIsLocal: true,
    scratch: { lasts: "run-start", path: "/work/tmp" },
  }),
  library: null,
  live: false,
};
const stops = [
  { kind: "turn_limit", limit: 12 },
  { count: 5, kind: "repeat", tool: "Bash" },
] as const;
const local = createMemoryLocal();
const remote = createMemoryRemote();
const manifest = createMemoryManifest();
const roots = [
  { mode: "write" as const, path: "agents/ada" },
  { mode: "read" as const, path: "agents/ada/read" },
];
const sync = createLibrarySync({ local, manifest, remote });
remote.put("agents/ada/note", "initial");
remote.put("agents/ada/read/file", "truth");
const initial = await sync.syncIn({ roots });
local.put("agents/ada/note", "local");
local.put("agents/ada/read/file", "refused");
remote.put("agents/ada/note", "remote");
const pull = await sync.syncIn({ roots });
const push = await sync.syncOut({ roots, runId: "r" });
const syncFixture = {
  initial,
  local: Object.fromEntries(
    [...local.files].map(([path, bytes]) => [path, textOf(bytes)])
  ),
  pull,
  push,
  remote: Object.fromEntries(
    [...remote.files].map(([path, file]) => [path, textOf(file.bytes)])
  ),
};
await write(
  new URL("parity.json", import.meta.url),
  `${JSON.stringify({ keys, masker: { expected: createMasker(secrets).mask(source), secrets, source }, outcomes: [...outcomes, ...answered], prompts: [...prompts, noLibraryPrompt], questions: { answer, expected: askUserQuestionAnswers(questions, answer), input: questions }, stops: stops.map((stop) => ({ expected: stopMessage(stop), stop })), summaries, sync: syncFixture, taskFolder: taskFolderPath("ada", "r"), turns }, null, 2)}\n`
);
