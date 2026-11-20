import type { MemoryChange } from "@repo/db/shared";
import type { MemoryChangeInfo, MemoryPort } from "@repo/mcp/ports";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

const toChangeInfo = (change: MemoryChange): MemoryChangeInfo => ({
  changeId: change.id,
  noteId: change.noteId,
  status: change.status,
});

export const createMemoryPorts = ({
  principal,
  services,
}: {
  principal: Extract<Principal, { kind: "run" }>;
  services: Pick<Services, "memory" | "sessions">;
}): MemoryPort => ({
  forget: ({ id }) =>
    guarded(async () =>
      toChangeInfo(
        await services.memory.forget(principal, {
          agentId: principal.agentId,
          noteId: id,
        })
      )
    ),
  remember: (input) =>
    guarded(async () =>
      toChangeInfo(
        await services.memory.add(principal, {
          ...input,
          agentId: principal.agentId,
          source: { id: principal.runId, kind: "run" },
        })
      )
    ),
  searchHistory: ({ query, limit }) =>
    guarded(async () => {
      const hits = await services.sessions.search(principal, {
        agentId: principal.agentId,
        query,
      });
      return hits.slice(0, limit).map(({ passages, session }) => ({
        passages,
        session: {
          createdAt: session.createdAt,
          id: session.id,
          lastRunAt: session.lastRunAt,
          origin: session.origin,
          status: session.status,
          title: session.title,
        },
      }));
    }),
});
