/** Separate scoped registry. General platform ports never enter this server. */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerTools } from "./register";
import { ToolError } from "./result";
import { type DeckPort, deckTools } from "./tools/deck";
import type { ToolDefinition } from "./tools/define";
import { type LivePort, liveTools } from "./tools/live";

export interface GuestToolScope {
  artifactId: string;
  kind: "document" | "deck";
  role: "commenter" | "editor";
}
export const guestTools = (deps: {
  supported?: readonly string[];
  scope: GuestToolScope;
  /** Must consult current run/provenance, session, switches and member role. */
  authorize: (artifactId: string, write: boolean) => Promise<GuestToolScope>;
  live?: LivePort;
  deck?: DeckPort;
  comments?: LivePort["comment"];
  /** Dedicated pending-suggestion ports. Direct mutation ports are never used
   * for guest-agent edits, including editor guests (PRD phase 4). */
  suggestions?: { document?: LivePort["edit"]; deck?: DeckPort["write"] };
}): readonly ToolDefinition[] => {
  let definitions: ToolDefinition[] = [];
  if (deps.scope.kind === "document" && deps.live) {
    const edit = deps.suggestions?.document;
    definitions = liveTools({
      ...deps.live,
      comment: deps.comments ?? deps.live.comment,
      edit: edit ?? deps.live.edit,
    }).filter(
      (tool) =>
        tool.name !== "document_create" &&
        (tool.name !== "document_comment" || Boolean(deps.comments)) &&
        (tool.name !== "document_edit" || Boolean(edit))
    );
  }
  if (deps.scope.kind === "deck" && deps.deck) {
    const write = deps.suggestions?.deck;
    definitions = deckTools({
      ...deps.deck,
      write: write ?? deps.deck.write,
    }).filter((tool) => tool.name !== "deck_write" || Boolean(write));
  }
  if (deps.scope.kind === "deck" && deps.live) {
    definitions.push(
      ...liveTools({
        ...deps.live,
        comment: deps.comments ?? deps.live.comment,
      })
        .filter(
          (tool) =>
            tool.name === "document_comments" ||
            (tool.name === "document_comment" && Boolean(deps.comments))
        )
        .map((tool) => ({
          ...tool,
          name: tool.name.replace("document_", "deck_"),
          ...(tool.name === "document_comment"
            ? { inputSchema: deckCommentSchema }
            : {}),
        }))
    );
  }
  return definitions
    .filter((tool) => !deps.supported || deps.supported.includes(tool.name))
    .filter(
      (tool) =>
        deps.scope.role === "editor" ||
        (tool.name !== "document_edit" && tool.name !== "deck_write")
    )
    .map((tool) => ({
      ...tool,
      run: async (raw) => {
        const input = tool.inputSchema.parse(raw) as { artifactId?: string };
        if (input.artifactId !== deps.scope.artifactId) {
          throw new ToolError("forbidden", "Guest artifact scope required");
        }
        if (
          tool.name === "document_comment" &&
          (input as { to?: string }).to === "agent"
        ) {
          throw new ToolError(
            "forbidden",
            "Guest agent handoff is unavailable"
          );
        }
        const write =
          tool.name === "document_edit" || tool.name === "deck_write";
        const current = await deps.authorize(input.artifactId, write);
        if (
          current.artifactId !== deps.scope.artifactId ||
          current.kind !== deps.scope.kind ||
          !["commenter", "editor"].includes(current.role) ||
          (write && current.role !== "editor")
        ) {
          throw new ToolError("forbidden", "Guest artifact scope required");
        }
        const result = await tool.run(input);
        await deps.authorize(input.artifactId, write);
        return result;
      },
    }));
};
export const createGuestMcpServer = (
  deps: Parameters<typeof guestTools>[0]
) => {
  const server = new McpServer(
    { name: "agentum-guest", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerTools(server, guestTools(deps));
  return server;
};

const deckCommentSchema = z
  .strictObject({
    answered: z.literal(true).optional(),
    artifactId: z.uuid(),
    body: z.string().trim().min(1).max(4096).optional(),
    threadId: z.string().min(1).max(200).optional(),
  })
  .refine(
    (input) =>
      Boolean(input.body || (input.threadId && input.answered)) &&
      (!input.answered || Boolean(input.threadId))
  );
