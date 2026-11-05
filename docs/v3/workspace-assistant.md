# Workspace assistant

Status: asked for by Dom on 5 Nov 2026 ("build straight away"). Tasks WA.1 to WA.3.

## Why

Dom wants one chat in the web app where he can do everything he can do in the workspace by asking: create and change agents, talk to agents, and handle the delicate parts too, such as storing a secret, granting it to an agent, or setting a model provider key. The assistant is not an agent. It has no profile, no machine and no runs. It is the signed-in person, acting through a model.

Secrets must never pass through the chat or the model. T3 Code (pingdotgg/t3code) solves this with a `request_secret` tool: the model asks, the chat shows a form, and the value goes straight to storage. We copy that pattern.

## What it is

- A page at `/assistant`, in the rail and in `rail/find-registry.ts`. Desktop: the conversation in the main pane with a list of the person's earlier conversations. Phone: the conversation full screen, with the list behind a back button.
- Conversations belong to one person in one workspace. Nobody else sees them, admins included.
- The model call is server side, on the workspace's own key, exactly as the agent builder does it (`packages/services/src/agent-builder/service.ts`: `managedKeys.resolve`, the Anthropic Messages API, `CLOUD_DEFAULT_MODEL`). With no key, the page says so and links to Model providers, as the builder does.

## Who may do what

The assistant's tools are the MCP tools, bound to the person's browser-session principal through the same `createMcpPorts` and `agentumTools` the `/mcp` route uses. It gets nothing a person couldn't do in the UI. Every write goes through the same services, `authorize()` calls and audit records.

- Any member: the read tools, `send_message`, `get_run`, `cancel_run`, sessions, inbox, routines, triggers, skills, library, wiki, artifacts, and the agent management tools (`create_agent`, `update_agent`, `get_agent`, `archive_agent`, `restore_agent`, `set_agent_owners`, `set_agent_ask_before`, address tools). `requireAgentManager` admits a user principal with `via: "session"`, because the UI already lets members do these.
- Org admins (`principal.isAdmin`) only: `grant_secret`, `revoke_secret`, and the two card tools below.
- Never: `create_secret` (it takes the value as input), `create_api_key` and `create_enrolment_code` (their results are credentials that would land in the model's context), `delete_connector`, and the computer and browser tools. Leave them out of the assistant's list by name. The `/mcp` route is unchanged.

A browser session is not an MCP token, so nothing in this opens a new remote path: the tools run in-process inside the tRPC call that served the signed-in page.

## The secret card

Two card tools exist only in the assistant, not on `/mcp`:

- `request_secret({ name, mode, hosts?, rules?, reason, grantTo? })`. Same `mode`, `hosts` and proxy `rules` shape as `create_secret`, without a value. `grantTo` is a list of agent ids or slugs. `reason` is one sentence the card shows.
- `request_model_key({ provider, reason })`, for the providers Model providers lists.

When the model calls one, the turn stops. The chat shows a card with what the model filled in (name, mode, hosts or header rule, the agents it will be granted to, the reason), all editable, and a password field. The person can:

- **Save**: the browser sends the value straight to the existing `secrets.create` (then `secrets.setGrants` for `grantTo`) or `modelKeys` tRPC mutation. The value never goes to the assistant's endpoints, its tables or the model. The browser then tells the assistant the outcome, and the model's tool result is only `{ saved: true, secretId, name, mode, hosts, grantedTo }`.
- **Cancel**: the tool result is `{ saved: false, reason: "cancelled" }`.
- Leave it: the card stays open in the conversation. A new message from the person cancels it first.

A card that has been answered collapses to one line ("Saved secret GITHUB_TOKEN, granted to Release bot"). A refused save (a name clash, a bad host) shows the service's error on the card and keeps it open.

Details taken from T3 Code's `SecretRequestCard`:

- The value field is `type="text"` with `-webkit-text-security: disc`, `autoComplete="off"`, and the 1Password, LastPass and Bitwarden ignore attributes (`data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`), so password managers don't offer to save it. It has a Show toggle.
- Buttons are "Save securely" and "Decline". Under them: "Stored in this workspace. The assistant never sees the value."
- Each outcome carries a note for the model. Declined or cancelled: "The person declined. Don't ask for it in chat or another way. Say what is blocked and go on without it." The tool description says the same, and says to call the card rather than offer it.
- After a decline the model must not open a second card for the same thing in that turn. The server refuses a second `request_secret` with the same name in one turn.
- `resolveCard` is idempotent on `toolUseId`. If the save succeeded but `resolveCard` failed, the card retries `resolveCard` only and never creates the secret twice.

## Confirm before destructive tools

A tool whose annotations say `destructiveHint: true` (archive, revoke, cancel run, deletes) doesn't run straight away. The chat shows a confirm card naming the tool and its arguments in words, with Run and Don't run. The tool result tells the model which was chosen. Create and update tools run without asking, and the conversation shows each call as a collapsible line (tool title, short result).

## Keeping keys out of the chat

- The system prompt says: never ask for a secret, key, token or password in chat; always use `request_secret` or `request_model_key`; never repeat a value.
- Before a person's message goes to the model, the server checks it for key-shaped text (known prefixes such as `sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `xox`, `AKIA`, `ag_`, `hm_`, a JWT, a PEM block, and a long high-entropy token). If it finds one, it refuses with "That looks like a key. Use Add secret instead." and stores nothing. The page offers Add secret, which opens the same card without the model.
- Tool results are scrubbed for the person's workspace secret values before they reach the model or the tables, as `secrets/scrub.ts` does for runs.

## The loop

- `assistant.send({ conversationId?, text })` stores the message, then calls the model and runs tools until the model answers in text, stops at a card, or reaches 16 tool calls (then it says it stopped and asks the person to continue).
- `assistant.resolveCard({ conversationId, toolUseId, outcome })` records the card's outcome as the tool result and continues the loop the same way.
- No streaming in this version. The page shows a working line while the call runs and renders the stored steps when it returns. A turn that fails keeps everything up to the failure and shows the error.
- Each tool call and result is stored, so a reload shows the same conversation, and an open card is still open.

## Storage

Two tables in `packages/db`: `assistant_conversations` (id, workspace_id, user_id, title, created_at, updated_at) and `assistant_messages` (id, conversation_id, seq, role, content JSON in the Anthropic message shape, created_at). The title is the first message cut to 80 characters. Archive a conversation from its menu; there is no hard delete.

## Out of scope

Streaming, voice, attachments, an assistant that starts on its own, sharing conversations, and the assistant on `/mcp`.
