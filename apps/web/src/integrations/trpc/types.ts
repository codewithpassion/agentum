// Output types of the tRPC procedures, for components. Type-only, so nothing
// from the server reaches the browser bundle.
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "#/server/trpc/router";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type AgentRecord = RouterOutputs["agents"]["get"];
export type MachineRecord = RouterOutputs["machines"]["list"][number];
export type SessionListItem = RouterOutputs["sessions"]["list"][number];
export type SessionTranscript = RouterOutputs["sessions"]["transcript"];
