import { z } from "zod";
import type { McpPorts } from "../ports";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_CREATE,
} from "./define";

// Paths and access are checked by the service adapter, as for library tools.
const path = z
  .string()
  .min(1)
  .describe(
    "The wiki/**/*.md library path, from library_list or wiki_read links."
  );

export const wikiTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Reads a wiki page's body, title, resolved links (including broken targets) and backlinks. Supply a wiki/**/*.md library path; use library_list to find pages.",
    inputSchema: z.strictObject({ path }),
    name: "wiki_read",
    run: async (input) => {
      const page = await ports.wikiRead(input);
      return { data: page, text: JSON.stringify(page, null, 2) };
    },
    title: "Read a wiki page",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Proposes a complete replacement body for a wiki page, with a summary for human review. Does not publish the edit. Returns suggestionId. Read the page with wiki_read first. The service may replace an earlier pending suggestion from this agent for the same page.",
    inputSchema: z.strictObject({
      body: z
        .string()
        .describe("Complete proposed Markdown body, up to 10 MB of UTF-8."),
      path,
      summary: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("A brief explanation of the proposed edit for the reviewer."),
    }),
    name: "wiki_suggest_edit",
    run: async (input) => {
      const { id } = await ports.wikiSuggestEdit(input);
      return {
        data: { suggestionId: id },
        text: `Created wiki suggestion ${id} for review.`,
      };
    },
    title: "Suggest a wiki edit",
  }),
];
