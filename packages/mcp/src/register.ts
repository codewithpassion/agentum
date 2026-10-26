import type { McpServer } from "@modelcontextprotocol/server";
import { runSafely, type ToolPayload } from "./result";
import type { ServerOptions } from "./server";
import type { ToolDefinition } from "./tools/define";

/** The SDK has validated input before this handler runs, including schema defaults. */
const skipDryRun = async (
  definition: ToolDefinition,
  input: unknown,
  dryRun: NonNullable<ServerOptions["dryRun"]>
): Promise<ToolPayload> => {
  // Cut the compact JSON literally at 200 characters, even inside a value; no ellipsis.
  const summary = JSON.stringify(input).slice(0, 200);
  const action =
    definition.title.charAt(0).toLowerCase() + definition.title.slice(1);
  await dryRun.record({ summary, tool: definition.name });
  const libraryNotice =
    definition.name === "bash"
      ? " A dry run cannot use the library bash tool, reads included; cloud runs read the library with Pi's read tool instead."
      : "";
  return {
    data: { skipped: true, tool: definition.name },
    text: `Skipped in dry run: would ${action} ${summary}${libraryNotice}`,
  };
};

/** Registers every definition on `server`, with failures turned into error results. */
export const registerTools = (
  server: McpServer,
  definitions: readonly ToolDefinition[],
  { dryRun }: Pick<ServerOptions, "dryRun"> = {}
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
      (input) =>
        runSafely(() =>
          dryRun && definition.annotations.readOnlyHint !== true
            ? skipDryRun(definition, input, dryRun)
            : definition.run(input)
        )
    );
  }
};
