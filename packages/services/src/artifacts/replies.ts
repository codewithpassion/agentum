import type { Database } from "@repo/db";
import { artifacts } from "@repo/db/schema/artifacts";
import { runs } from "@repo/db/schema/runs";
import { and, eq, isNull } from "drizzle-orm";
import type { EventRecord, EventsService } from "../events.ts";
import {
  type DeliveryContext,
  type Gateway,
  type ReplyTarget,
  replyTargetSchema,
} from "../runs/types.ts";

export interface AppReplyHost {
  artifactId: string;
  meta: { ipPrefix: null; place: null; userAgent: null; visitorHash: string };
  versionId: string;
  viewer: { kind: "reply"; runId: string };
  workspaceId: string;
}
export interface AppReplyMessage {
  fileIds: string[];
  runId: string;
  state: string;
  status: "finished" | "failed" | "cancelled" | "interrupted";
  text: string;
}
export type AppReply = (
  host: AppReplyHost,
  message: AppReplyMessage
) => Promise<void>;

export const createAppReplies = ({
  db,
  defer,
  events,
  invoke,
}: {
  db: Database;
  defer?: (work: Promise<void>) => void;
  events: EventsService;
  invoke?: AppReply;
}) => {
  interface Diagnostics {
    agentId?: string | null;
    artifactId?: string;
    runId: string;
    sessionId?: string | null;
    workspaceId?: string;
  }
  const reportFailure = async (ids: Diagnostics) => {
    // Never log opaque state, malformed reply data, or error messages.
    if (ids.artifactId && ids.workspaceId) {
      try {
        await events.append({
          actor: { id: "system", kind: "system" },
          agentId: ids.agentId ?? null,
          payload: { artifactId: ids.artifactId },
          runId: ids.runId,
          sessionId: ids.sessionId ?? null,
          type: "app.reply_failed",
          workspaceId: ids.workspaceId,
        });
        return;
      } catch {
        // Failure-event storage can fail too; retain an ids-only diagnostic.
      }
    }
    console.error("app.reply_failed", ids);
  };
  const schedule = (
    ids: Diagnostics,
    work: (expired: () => boolean) => Promise<void>
  ) => {
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    // Start before either lookup. Leave time to persist failure within waitUntil.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error("App reply timed out"));
      }, 20_000);
    });
    const pending = Promise.race([
      deadline,
      Promise.resolve().then(() => work(() => expired)),
    ])
      .catch(() => reportFailure(ids))
      .finally(() => clearTimeout(timer))
      .catch(() => undefined);
    defer?.(pending);
  };
  const deliver = async (
    target: Extract<ReplyTarget, { kind: "app" }>,
    ids: Diagnostics,
    message: Omit<AppReplyMessage, "runId" | "state">,
    expired: () => boolean
  ) => {
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, ids.runId))
      .limit(1);
    if (!run) {
      throw new Error("Run not found");
    }
    if (expired()) {
      return;
    }
    Object.assign(ids, {
      agentId: run.agentId,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
    });
    if (!invoke) {
      throw new Error("Worker exports are unavailable");
    }
    const [app] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, target.artifactId),
          eq(artifacts.kind, "app"),
          isNull(artifacts.deletedAt),
          eq(artifacts.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    // An app without a live version has nothing to receive a reply.
    if (expired() || !app?.currentVersionId) {
      return;
    }
    await invoke(
      {
        artifactId: app.id,
        meta: { ipPrefix: null, place: null, userAgent: null, visitorHash: "" },
        versionId: app.currentVersionId,
        viewer: { kind: "reply", runId: ids.runId },
        workspaceId: app.workspaceId,
      },
      { ...message, runId: ids.runId, state: target.state }
    );
  };
  const gateway: Gateway = {
    deliver: (target, message, context: DeliveryContext) => {
      if (target.kind === "app") {
        const ids: Diagnostics = {
          agentId: context.agentId,
          artifactId: target.artifactId,
          runId: context.runId,
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
        };
        schedule(ids, (expired) =>
          deliver(target, ids, { ...message, status: "finished" }, expired)
        );
      }
      return Promise.resolve();
    },
    kind: "app",
  };
  const onEvent = (event: EventRecord) => {
    if (
      !(
        event.runId &&
        ["run.failed", "run.cancelled", "run.interrupted"].includes(event.type)
      )
    ) {
      return Promise.resolve();
    }
    const ids: Diagnostics = {
      agentId: event.agentId,
      runId: event.runId,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
    };
    schedule(ids, async (expired) => {
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, ids.runId))
        .limit(1);
      if (!run) {
        throw new Error("Run not found");
      }
      if (expired() || !run.reply) {
        return;
      }
      const raw: unknown = JSON.parse(run.reply);
      if (
        typeof raw === "object" &&
        raw !== null &&
        "artifactId" in raw &&
        typeof raw.artifactId === "string"
      ) {
        ids.artifactId = raw.artifactId;
      }
      const target = replyTargetSchema.parse(raw);
      if (target.kind !== "app") {
        return;
      }
      const statuses = {
        "run.cancelled": "cancelled",
        "run.failed": "failed",
        "run.interrupted": "interrupted",
      } as const;
      await deliver(
        target,
        ids,
        {
          fileIds: [],
          status: statuses[event.type as keyof typeof statuses],
          text: run.resultText ?? "",
        },
        expired
      );
    });
    return Promise.resolve();
  };
  return { gateway, onEvent };
};
