/** Separate scoped registry. General platform ports never enter this server. */
import { McpServer } from "@modelcontextprotocol/server";
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
  scope: GuestToolScope;
  /** Must consult current run/provenance, session, switches and member role. */
  authorize: (artifactId: string, write: boolean) => Promise<GuestToolScope>;
  live?: LivePort;
  deck?: DeckPort;
  /** Dedicated pending-suggestion ports. Direct mutation ports are never used
   * for guest-agent edits, including editor guests (PRD phase 4). */
  suggestions?: { document?: LivePort["edit"]; deck?: DeckPort["write"] };
}): readonly ToolDefinition[] => {
  let definitions: ToolDefinition[] = [];
  if (deps.scope.kind === "document" && deps.live) {
    const edit = deps.suggestions?.document;
    definitions = liveTools({
      ...deps.live,
      edit: edit ?? deps.live.edit,
    }).filter(
      (tool) =>
        tool.name !== "document_create" &&
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
  return definitions
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
    { name: "harbourmaster-guest", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerTools(server, guestTools(deps));
  return server;
};
