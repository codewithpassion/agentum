import type { Database } from "@repo/db";
import { artifacts } from "@repo/db/schema/artifacts";
import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import type { EventRecord, EventsService } from "../events.ts";
import type { Gateway, ReplyTarget } from "../runs/types.ts";

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
  events,
  invoke,
}: {
  db: Database;
  events: EventsService;
  invoke?: AppReply;
}) => {
  const deliver = async (
    target: Extract<ReplyTarget, { kind: "app" }>,
    runId: string,
    message: Omit<AppReplyMessage, "runId" | "state">
  ) => {
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) {
      return;
    }
    try {
      if (!invoke) {
        throw new Error("Worker exports are unavailable");
      }
      const [app] = await db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, target.artifactId),
            eq(artifacts.workspaceId, run.workspaceId)
          )
        )
        .limit(1);
      // An app without a live version has nothing to receive a reply.
      if (!app?.currentVersionId) {
        return;
      }
      await invoke(
        {
          artifactId: app.id,
          meta: {
            ipPrefix: null,
            place: null,
            userAgent: null,
            visitorHash: "",
          },
          versionId: app.currentVersionId,
          viewer: { kind: "reply", runId },
          workspaceId: app.workspaceId,
        },
        { ...message, runId, state: target.state }
      );
    } catch {
      // Opaque state can contain credentials: never log it or the app's error.
      await events.append({
        actor: { id: "system", kind: "system" },
        agentId: run.agentId,
        payload: { artifactId: target.artifactId },
        runId,
        sessionId: run.sessionId,
        type: "app.reply_failed",
        workspaceId: run.workspaceId,
      });
    }
  };
  const gateway: Gateway = {
    deliver: async (target, message, context) => {
      if (target.kind === "app") {
        await deliver(target, context.runId, {
          ...message,
          status: "finished",
        });
      }
    },
    kind: "app",
  };
  const onEvent = async (event: EventRecord) => {
    if (
      !(
        event.runId &&
        ["run.failed", "run.cancelled", "run.interrupted"].includes(event.type)
      )
    ) {
      return;
    }
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, event.runId))
      .limit(1);
    if (!run?.reply) {
      return;
    }
    const target = JSON.parse(run.reply) as ReplyTarget;
    if (target.kind !== "app") {
      return;
    }
    const statuses = {
      "run.cancelled": "cancelled",
      "run.failed": "failed",
      "run.interrupted": "interrupted",
    } as const;
    const status = statuses[event.type as keyof typeof statuses];
    await deliver(target, run.id, {
      fileIds: [],
      status,
      text: run.resultText ?? "",
    });
  };
  return { gateway, onEvent };
};
