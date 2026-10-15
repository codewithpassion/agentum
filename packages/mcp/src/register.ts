import type { McpServer } from "@modelcontextprotocol/server";
import { runSafely } from "./result";
import type { ToolDefinition } from "./tools/define";

/** Registers every definition on `server`, with failures turned into error results. */
export const registerTools = (
  server: McpServer,
  definitions: readonly ToolDefinition[]
): void => {
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        annotations: definition.annotations,
        description: definition.description,
        inputSchema: definition.inputSchema,
        title: definition.title,
      },
      (input) => runSafely(() => definition.run(input))
    );
  }
};
