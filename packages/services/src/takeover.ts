import type { Database } from "@repo/db";
import { runRequests } from "@repo/db/schema/requests";
import type {
  ComputerHandedBackPayload,
  ComputerTakenPayload,
} from "@repo/db/shared";
import { takeoverDisplaySchema } from "@repo/protocol/requests";
import { and, eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { RequestsService } from "./requests.ts";
import type { Principal } from "./workspaces.ts";

export const createTakeoverService = ({
  db,
  events,
  requests,
  lease,
}: {
  db: Database;
  events: EventsService;
  requests: RequestsService;
  lease?: {
    take: (machineId: string, userId: string) => Promise<void>;
    release: (machineId: string) => Promise<void>;
  };
}) => {
  const load = async (principal: Principal, requestId: string) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("requests.answer");
    }
    // Reuse request visibility, including private sessions, before reading the row.
    await requests.outcome(principal, requestId);
    const [row] = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.id, requestId),
          eq(runRequests.workspaceId, principal.workspaceId)
        )
      );
    if (row?.kind !== "takeover") {
      throw new ServiceError("not_found", "Takeover request not found");
    }
    return {
      display: takeoverDisplaySchema.parse(JSON.parse(row.display)),
      row,
      user: principal,
    };
  };
  const take = async (principal: Principal, requestId: string) => {
    const { row, user, display } = await load(principal, requestId);
    if (row.status !== "pending") {
      throw new ServiceError("conflict", "Already answered");
    }
    const payload: ComputerTakenPayload = {
      machineId: display.machineId,
      userId: user.userId,
    };
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: row.agentId,
      payload: { ...payload },
      runId: row.runId,
      sessionId: row.sessionId,
      type: "computer.taken",
      workspaceId: row.workspaceId,
    });
    await lease?.take(display.machineId, user.userId);
  };
  const handBack = async (
    principal: Principal,
    requestId: string,
    note?: string
  ) => {
    const { row, user, display } = await load(principal, requestId);
    const answered = await requests.answer(user, {
      answer: note ? { note } : {},
      requestId,
      via: "web",
    });
    await lease?.release(display.machineId);
    // The runtime receives the original note; the event uses the scrubbed answer.
    const cleanNote =
      answered.answer && "note" in answered.answer
        ? answered.answer.note
        : undefined;
    const payload: ComputerHandedBackPayload = {
      machineId: display.machineId,
      userId: user.userId,
      ...(cleanNote === undefined ? {} : { note: cleanNote }),
    };
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: row.agentId,
      payload: { ...payload },
      runId: row.runId,
      sessionId: row.sessionId,
      type: "computer.handed_back",
      workspaceId: row.workspaceId,
    });
  };
  const cancel = async (principal: Principal, requestId: string) => {
    const { user, display } = await load(principal, requestId);
    await requests.cancel(user, requestId);
    await lease?.release(display.machineId);
  };
  return { cancel, handBack, take };
};
export type TakeoverService = ReturnType<typeof createTakeoverService>;
