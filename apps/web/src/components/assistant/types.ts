import type { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";

export type Conversation = RouterOutputs["assistant"]["get"];
export type PendingCard = NonNullable<Conversation["pendingCard"]>;
export type CardOutcome = Parameters<
  ReturnType<typeof getTrpc>["assistant"]["resolveCard"]["mutate"]
>[0]["outcome"];
export type AssistantAgent = Pick<
  RouterOutputs["agents"]["list"][number],
  "id" | "slug" | "name"
>;
