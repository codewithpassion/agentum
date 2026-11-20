import type { DecisionsPort } from "@repo/mcp/ports";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

export const createDecisionsPorts = ({
  principal,
  services,
}: {
  principal: Extract<Principal, { kind: "run" }>;
  services: Pick<Services, "requests">;
}): DecisionsPort => ({
  ask: ({ questions }) =>
    guarded(async () => {
      const record = await services.requests.openDecisions(principal, {
        questions,
        runId: principal.runId,
      });
      return {
        count: questions.length,
        expiresAt: record.expiresAt,
        requestId: record.id,
      };
    }),
});
