// Output types of the tRPC procedures, for components. Type-only, so nothing
// from the server reaches the browser bundle.
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "#/server/trpc/router";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type AgentRecord = RouterOutputs["agents"]["get"];
export type MachineRecord = RouterOutputs["machines"]["list"][number];
export type SessionListItem = RouterOutputs["sessions"]["list"][number];
export type SessionTranscript = RouterOutputs["sessions"]["transcript"];
export type ApiKeyRecord = RouterOutputs["apiKeys"]["list"][number];
export type OAuthClientRecord = RouterOutputs["oauthClients"]["list"][number];
export type FileInfo = RouterOutputs["files"]["describe"][number];
export type ConnectorRecord = RouterOutputs["connectors"]["list"][number];
export type CredentialRecord = ConnectorRecord["agentCredentials"][number];
export type AssignmentRecord =
  RouterOutputs["connectors"]["assignments"][number];
export type TriggerRecord = RouterOutputs["triggers"]["list"][number];
export type RoutineRecord = RouterOutputs["routines"]["list"][number];
