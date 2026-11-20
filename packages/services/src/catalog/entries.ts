import type { CatalogEntry } from "@repo/db/shared";

// Array order is the picker order: Harbour Edge apps first, then public docs.
export const entries: readonly CatalogEntry[] = [
  // https://developers.google.com/workspace/gmail/api/reference/mcp
  {
    authKind: "oauth",
    defaultAllowedTools: [
      "get_message",
      "get_thread",
      "list_drafts",
      "list_labels",
      "search_threads",
    ],
    description: "Search email and read messages, threads and labels.",
    icon: "gmail",
    key: "gmail",
    name: "Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
  },
  // https://linear.app/docs/mcp
  {
    authKind: "oauth",
    defaultAllowedTools: [
      "list_issues",
      "get_issue",
      "list_projects",
      "get_project",
    ],
    description: "Find and read issues and projects.",
    icon: "linear",
    key: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
  },
  // Tool names: https://developers.notion.com/guides/mcp/tools-search-reference
  // https://developers.notion.com/docs/mcp
  {
    authKind: "oauth",
    defaultAllowedTools: ["notion-search", "notion-fetch"],
    description: "Search and read workspace pages and databases.",
    icon: "notion",
    key: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
  },
  // Tool names: https://github.com/slackapi/slack-skills-plugin/blob/main/commands/standup.md
  // https://docs.slack.dev/ai/mcp-server
  {
    authKind: "oauth",
    defaultAllowedTools: ["slack_search_public", "slack_read_thread"],
    description: "Search messages and read conversation threads.",
    icon: "slack",
    key: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
  },
  // https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/docs-ai-search
  {
    authKind: "none",
    defaultAllowedTools: ["search_cloudflare_documentation"],
    description: "Search Cloudflare developer documentation.",
    icon: "cloudflare",
    key: "cloudflare-docs",
    name: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
  },
];
