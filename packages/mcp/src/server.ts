import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../package.json";
import type { McpPorts } from "./ports";
import { registerTools } from "./register";
import { adminSetupTools, adminWriteTools } from "./tools/admin";
import { agentTools, agentWriteTools } from "./tools/agents";
import { artifactTools } from "./tools/artifacts";
import { browserTools } from "./tools/browser";
import { computerTools } from "./tools/computer";
import type { ToolDefinition } from "./tools/define";
import { inboxTools } from "./tools/inbox";
import { libraryTools } from "./tools/library";
import { liveTools } from "./tools/live";
import { mailTools } from "./tools/mail";
import { qaTools } from "./tools/qa";
import { routineTools } from "./tools/routines";
import { sessionTools } from "./tools/sessions";
import { skillReadTools } from "./tools/skills-read";
import { skillWriteTools } from "./tools/skills-write";
import { slackTools } from "./tools/slack";
import { triggerTools } from "./tools/triggers";
import { wikiTools } from "./tools/wiki";

export interface ServerOptions {
  /** The key's access; set by the route only for an API key with write or admin access. */
  admin?: "admin" | "write";
  browser?: boolean;
  computer?: { desktop: boolean };
  /** Record skipped writes without calling their ports. */
  dryRun?: {
    record: (skip: { summary: string; tool: string }) => Promise<void>;
  };
  /** The route opts in only for a run principal whose agent has an active mailbox. */
  mail?: boolean;
  /** Q&A is available to every agent once the app supplies its bound port. */
  qa?: boolean;
  /**
   * The caller is a read-only API key or connected app. It then gets the
   * list tools for routines and triggers and the read tools for skills, and
   * none that change them.
   */
  readOnly?: boolean;
}

/** The tools that manage routines and triggers; a read-only caller gets the read ones. */
const automationTools = (
  ports: McpPorts,
  readOnly: boolean
): ToolDefinition[] => {
  const tools = [...routineTools(ports), ...triggerTools(ports)];
  return readOnly
    ? tools.filter((tool) => tool.annotations.readOnlyHint === true)
    : tools;
};

/** The tools that read and change skills; a read-only caller gets the read ones. */
const skillTools = (ports: McpPorts, readOnly: boolean): ToolDefinition[] =>
  readOnly
    ? skillReadTools(ports)
    : [...skillReadTools(ports), ...skillWriteTools(ports)];

/** Every tool this server offers, bound to the ports it calls. */
export const harbourmasterTools = (
  ports: McpPorts,
  {
    readOnly = false,
    mail = false,
    qa = false,
    computer,
    browser = false,
    admin,
  }: ServerOptions = {}
): readonly ToolDefinition[] => [
  ...(computer && !readOnly && ports.computer
    ? computerTools(ports, computer)
    : []),
  ...(browser && !readOnly && ports.browser ? browserTools(ports) : []),
  ...agentTools(ports),
  ...(readOnly ? [] : agentWriteTools(ports)),
  ...sessionTools(ports),
  ...inboxTools(ports),
  // Offered once the app wires the port; a read-only caller keeps the read tools.
  ...(ports.artifacts
    ? artifactTools(ports.artifacts, ports.live).filter(
        (tool) => !readOnly || tool.annotations.readOnlyHint === true
      )
    : []),
  ...(ports.live
    ? liveTools(ports.live).filter(
        (tool) => !readOnly || tool.annotations.readOnlyHint === true
      )
    : []),
  // V4.13 leaves read-only callers unspecified: new writes follow the skills convention.
  // Keep the existing bash availability unchanged.
  ...[...libraryTools(ports), ...wikiTools(ports)].filter(
    (tool) =>
      !readOnly ||
      tool.name === "bash" ||
      tool.annotations.readOnlyHint === true
  ),
  ...automationTools(ports, readOnly),
  ...skillTools(ports, readOnly),
  ...(readOnly ? [] : slackTools(ports)),
  ...(mail && !readOnly && ports.mail ? mailTools(ports) : []),
  ...(qa && ports.qa
    ? qaTools(ports).filter(
        (tool) => !readOnly || tool.annotations.readOnlyHint === true
      )
    : []),
  ...(admin && !readOnly && ports.admin ? adminWriteTools(ports.admin) : []),
  ...(admin === "admin" && !readOnly && ports.admin
    ? adminSetupTools(ports.admin)
    : []),
];

/** Ports for reading tool names: the names do not depend on them, so none is ever called. */
const unusedPort = (): Promise<never> =>
  Promise.reject(new Error("Only the tool names are read."));

/** Default tool names in registration order; mail, Q&A, computer and browser groups require opt-in. */
export const TOOL_NAMES = harbourmasterTools({
  approveSkillVersion: unusedPort,
  artifacts: {
    create: unusedPort,
    list: unusedPort,
    promote: unusedPort,
    read: unusedPort,
    test: unusedPort,
    update: unusedPort,
  },
  assignSkill: unusedPort,
  cancelRun: unusedPort,
  commitSkill: unusedPort,
  createRoutine: unusedPort,
  createSkill: unusedPort,
  createTrigger: unusedPort,
  deleteRoutine: unusedPort,
  deleteSkill: unusedPort,
  deleteTrigger: unusedPort,
  exportSkill: unusedPort,
  getRun: unusedPort,
  importSkill: unusedPort,
  inboxList: unusedPort,
  inboxPost: unusedPort,
  inboxRead: unusedPort,
  libraryBash: unusedPort,
  libraryList: unusedPort,
  libraryRead: unusedPort,
  libraryVersions: unusedPort,
  libraryWrite: unusedPort,
  listAgents: unusedPort,
  listRoutines: unusedPort,
  listSessions: unusedPort,
  listSkills: unusedPort,
  listTriggers: unusedPort,
  live: {
    comment: unusedPort,
    comments: unusedPort,
    create: unusedPort,
    edit: unusedPort,
    read: unusedPort,
  },
  pinSkill: unusedPort,
  readSession: unusedPort,
  rejectSkillVersion: unusedPort,
  revertSkill: unusedPort,
  searchSessions: unusedPort,
  sendMessage: unusedPort,
  setRoutineEnabled: unusedPort,
  setTriggerEnabled: unusedPort,
  skillDiff: unusedPort,
  skillLog: unusedPort,
  skillShow: unusedPort,
  slackDestinations: unusedPort,
  slackHistory: unusedPort,
  slackSearch: unusedPort,
  slackSend: unusedPort,
  unassignSkill: unusedPort,
  wikiRead: unusedPort,
  wikiSuggestEdit: unusedPort,
}).map((tool) => tool.name);

/**
 * A fresh MCP server. This package knows nothing about Workers, Hono or
 * Clerk; the web app owns HTTP and authentication, and passes the ports the
 * tools call.
 */
export const createHarbourmasterMcpServer = (
  ports: McpPorts,
  options: ServerOptions = {}
): McpServer => {
  // The tool list never changes after the server starts, so do not advertise
  // list changes: a client then never opens a `subscriptions/listen` stream
  // that could not receive an event anyway.
  const server = new McpServer(
    { name: "harbourmaster", version: packageJson.version },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerTools(server, harbourmasterTools(ports, options), options);
  return server;
};
