// Output types of the tRPC procedures, for components. Type-only, so nothing
// from the server reaches the browser bundle.
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "#/server/trpc/router";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type AgentRecord = RouterOutputs["agents"]["get"];
export type MachineRecord = RouterOutputs["machines"]["list"][number];
export type SessionListItem = RouterOutputs["sessions"]["list"][number];
export type SessionTranscript = RouterOutputs["sessions"]["transcript"];
export type EventLogPage = RouterOutputs["events"]["list"];
export type EventLogEntry = EventLogPage["entries"][number];
export type ApiKeyRecord = RouterOutputs["apiKeys"]["list"][number];
export type OAuthClientRecord = RouterOutputs["oauthClients"]["list"][number];
export type FileInfo = RouterOutputs["files"]["describe"][number];
export type ConnectorRecord = RouterOutputs["connectors"]["list"][number];
export type CredentialRecord = ConnectorRecord["agentCredentials"][number];
export type AssignmentRecord =
  RouterOutputs["connectors"]["assignments"][number];
export type TriggerRecord = RouterOutputs["triggers"]["list"][number];
export type RoutineRecord = RouterOutputs["routines"]["list"][number];
export type InboxThread = RouterOutputs["inbox"]["listThreads"][number];
export type InboxThreadView = RouterOutputs["inbox"]["readThread"];
export type InboxPost = InboxThreadView["posts"][number];
export type SlackAppRecord = RouterOutputs["slackApps"]["list"][number];
export type LibraryEntryRecord = RouterOutputs["library"]["list"][number];
export type LibraryFileView = RouterOutputs["library"]["read"];
export type SkillEntry = RouterOutputs["skills"]["list"][number];
export type SkillTreeFile = RouterOutputs["skills"]["files"][number];
export type SkillFileView = RouterOutputs["skills"]["readFile"];
export type SkillSummary = RouterOutputs["skillStore"]["list"][number];
export type SkillVersion = RouterOutputs["skillStore"]["log"][number];
export type SkillVersionFile =
  RouterOutputs["skillStore"]["show"]["files"][number];
export type SkillDiffResult = RouterOutputs["skillStore"]["diff"];
export type SkillAssignment =
  RouterOutputs["skillStore"]["assignments"][number];
export type AgentSkill = RouterOutputs["skillStore"]["forAgent"][number];
