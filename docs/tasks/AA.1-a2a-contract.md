---
id: AA.1
title: "Agent connections contract: A2A package, schema, shared values"
milestone: AA
size: M
status: done
depends_on: []
branch: task/AA.1-a2a-contract
lane: db
executor: claude
---

Spec: `docs/v3/agent-connections.md`. It is part of this task and wins over anything else. The sections that matter here are "A2A mapping", "Data model" and "Code layout".

A2A wire reference: https://a2a-protocol.org/latest/specification/ and the normative proto at https://raw.githubusercontent.com/a2aproject/A2A/main/specification/a2a.proto. Read the proto before writing the schemas. Field names, enum strings and the Part oneof must come from it, not from memory. Enums serialise as `TASK_STATE_COMPLETED` and `ROLE_USER`. There is no `kind` discriminator in 1.0.

## Scope
- New package `packages/a2a` (`@repo/a2a`), one `exports` subpath per module, no barrel. It imports only zod and has no database or Worker imports. It holds:
  - zod schemas and types for AgentCard, AgentInterface, AgentCapabilities, AgentExtension, AgentSkill, AgentProvider, SecurityScheme, SecurityRequirement, Message, Part, Task, TaskStatus, Artifact, StreamResponse, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, SendMessageRequest, SendMessageConfiguration, SendMessageResponse, TaskPushNotificationConfig, AuthenticationInfo.
  - These schemas read what peers send, so they ignore unknown fields rather than refuse them, a text part with `mediaType` is a text part, and a `SecurityScheme` also parses Hermes's `{ "type": "http", "scheme": "bearer" }` as bearer. See "Hermes compatibility" in the design. Hermes's real card and a Hermes text message go in the test fixtures.
  - The task state helpers: which states are terminal and which are interrupted.
  - The error table from spec section 5.4 (name, JSON-RPC code, HTTP status, reason) and builders for both error body shapes described in the design's "A2A mapping".
  - The JSON-RPC envelope parse and build, and a REST route table for the HTTP+JSON operations.
  - The two extension URIs (pairing and hops) as constants, and the metadata key for the hop count.
- The tables in the design's "Data model", in `packages/db/src/schema/a2a.ts`, with one generated migration including `migrations/meta/`, and a package export. Foreign keys to `agents`, `runs` and `sessions` where the columns name them. Indexes for: inbound token hash (unique), invite token hash (unique), public id (unique), `(connection_id, message_id)` (unique), outbox due rows, outbound tasks due for polling.
- Shared values in `packages/db/src/shared.ts`: `a2a` in `SESSION_ORIGINS`, `peer` in `EVENT_ACTOR_KINDS`, the `a2a.*` event types, and the status and policy enums with their defaults.
- The pairing code columns and the `a2a_pairing_requests` table from the design's "Data model", for AA.9.
- A `kind: "a2a"` reply target in `replyTargetSchema` with a task id.

Later tasks build the services, routes and UI. This one adds no behaviour, except that the type changes must compile: any exhaustive switch over the changed unions gets the minimum case.

## Check
- `bun test` in `packages/a2a` covers: every state helper, every error row, a JSON-RPC round trip, and parsing the sample Agent Card and Task JSON from the spec. A card with a 0.3-style `kind` part is refused.
- `bun test` in `packages/db` passes, the migration applies on `migrated()`, and the `events` triggers survive it (it must not recreate `events`).
- `grep -r "drizzle\|cloudflare:" packages/a2a/src` finds nothing.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created from Dom's request to design and build agent connections.
- 2026-10-31: dispatched.
- 2026-11-01: scope extended mid-run with Hermes tolerance in the schemas; the dispatcher was told.
- 2026-11-01: pairing columns and table added mid-run for AA.9; the dispatcher was told.
- 2026-11-01: merged, review clean after 2 fix rounds. One migration, 0036.
