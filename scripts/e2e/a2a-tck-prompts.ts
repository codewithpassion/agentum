// What the TCK's message id prefixes ask the agent under test to do, in words
// the dev-only `faux` model understands (apps/web/src/server/pi-run-faux.ts).
// The TCK's own scenarios are in `scenarios/*.feature` of its checkout. See
// a2a-tck-proxy.ts for why a message id has to be turned into a prompt.
//
// Left out on purpose, because an Agentum agent has no such behaviour:
// `tck-reject-task` (a task is rejected by a person declining it, or by a
// revoke), `tck-message-response` (a reply is always a task), and the file and
// data artifacts (files and JSON output are not in this build).

/** [message id prefix, prompt] pairs. The first prefix that matches wins. */
export const TCK_PROMPTS: readonly (readonly [string, string])[] = [
  ["tck-complete-task", "say Hello from TCK"],
  ["tck-artifact-text", "say Generated text content"],
  ["tck-stream-artifact-text", "say Streamed text content"],
  ["tck-stream-", "say Stream hello from TCK"],
  ["tck-input-required", "ask The TCK needs more input"],
  ["test-resubscribe-message-id", "slow"],
];

export const promptForMessageId = (messageId: string): string | null =>
  TCK_PROMPTS.find(([prefix]) => messageId.startsWith(prefix))?.[1] ?? null;
