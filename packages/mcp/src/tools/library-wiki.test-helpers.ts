import type { McpPorts } from "../ports";
import { createHarbourmasterMcpServer, type ServerOptions } from "../server";
import { connectClient } from "../testing";

const uncalled = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} should not be called`));

export const fakePorts = (overrides: Partial<McpPorts> = {}): McpPorts => ({
  approveSkillVersion: uncalled("approveSkillVersion"),
  assignSkill: uncalled("assignSkill"),
  cancelRun: uncalled("cancelRun"),
  commitSkill: uncalled("commitSkill"),
  createRoutine: uncalled("createRoutine"),
  createSkill: uncalled("createSkill"),
  createTrigger: uncalled("createTrigger"),
  deleteRoutine: uncalled("deleteRoutine"),
  deleteTrigger: uncalled("deleteTrigger"),
  exportSkill: uncalled("exportSkill"),
  getRun: uncalled("getRun"),
  importSkill: uncalled("importSkill"),
  inboxList: uncalled("inboxList"),
  inboxPost: uncalled("inboxPost"),
  inboxRead: uncalled("inboxRead"),
  libraryBash: uncalled("libraryBash"),
  libraryList: uncalled("libraryList"),
  libraryRead: uncalled("libraryRead"),
  libraryVersions: uncalled("libraryVersions"),
  libraryWrite: uncalled("libraryWrite"),
  listAgents: uncalled("listAgents"),
  listRoutines: uncalled("listRoutines"),
  listSessions: uncalled("listSessions"),
  listSkills: uncalled("listSkills"),
  listTriggers: uncalled("listTriggers"),
  pinSkill: uncalled("pinSkill"),
  readSession: uncalled("readSession"),
  rejectSkillVersion: uncalled("rejectSkillVersion"),
  revertSkill: uncalled("revertSkill"),
  searchSessions: uncalled("searchSessions"),
  sendMessage: uncalled("sendMessage"),
  setRoutineEnabled: uncalled("setRoutineEnabled"),
  setTriggerEnabled: uncalled("setTriggerEnabled"),
  skillDiff: uncalled("skillDiff"),
  skillLog: uncalled("skillLog"),
  skillShow: uncalled("skillShow"),
  slackDestinations: uncalled("slackDestinations"),
  slackHistory: uncalled("slackHistory"),
  slackSearch: uncalled("slackSearch"),
  slackSend: uncalled("slackSend"),
  unassignSkill: uncalled("unassignSkill"),
  wikiRead: uncalled("wikiRead"),
  wikiSuggestEdit: uncalled("wikiSuggestEdit"),
  ...overrides,
});

export const callTool = async (
  ports: McpPorts,
  name: string,
  args: Record<string, unknown>,
  options: ServerOptions = {}
) => {
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(ports, options)
  );
  try {
    return await client.callTool({ arguments: args, name });
  } finally {
    await close();
  }
};
