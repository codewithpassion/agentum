import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { z as zod } from "zod";
import { ToolError, type ToolPayload } from "../result";

/**
 * One tool: a zod input schema, a description written for an LLM and the
 * function that runs it. Adding a tool is one entry in its area's array.
 */
export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  annotations: ToolAnnotations;
  /** Written for an LLM: what comes back, when to use it, where ids come from. */
  description: string;
  inputSchema: Schema;
  name: string;
  run: (input: z.output<Schema>) => Promise<ToolPayload>;
  title: string;
}

/**
 * Ties `run`'s input to `inputSchema` while the arrays stay uniform. The cast
 * is safe because the SDK validates the arguments against `inputSchema` and
 * refuses the call before the handler ever runs.
 */
export const defineTool = <Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>
): ToolDefinition => ({
  ...definition,
  run: (input) => definition.run(input as z.output<Schema>),
});

/** Every read tool carries this. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

/*
 * Write tools state every hint: the MCP spec reads a missing
 * `destructiveHint` on a non-read-only tool as true.
 */

/** Creates a record: a repeat creates another one. */
export const WRITE_CREATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  readOnlyHint: false,
};

/*
 * Real input schemas land with M2.1 and M2.3. Until then a placeholder takes
 * no arguments and every call answers `not_implemented`.
 */
export const placeholderTool = (
  definition: Pick<
    ToolDefinition,
    "annotations" | "description" | "name" | "title"
  >
): ToolDefinition =>
  defineTool({
    ...definition,
    inputSchema: zod.strictObject({}),
    run: (): Promise<ToolPayload> => {
      throw new ToolError("not_implemented", "not implemented");
    },
  });
