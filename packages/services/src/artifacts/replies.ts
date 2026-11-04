import type { Database } from "@repo/db";
import { artifacts } from "@repo/db/schema/artifacts";
import { runs } from "@repo/db/schema/runs";
import { and, eq, isNull } from "drizzle-orm";
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
  defer,
  events,
  invoke,
}: {
  db: Database;
  defer?: (work: Promise<void>) => void;
  events: EventsService;
  invoke?: AppReply;
}) => {
  const deliver = async (
    target: Extract<ReplyTarget, { kind: "app" }>,
    runId: string,
    message: Omit<AppReplyMessage, "runId" | "state">
  ) => {
    let run: typeof runs.$inferSelect | undefined;
    try {
      [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    } catch {
      // Delivery lookup failures must never escape into run completion.
      return;
    }
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
            eq(artifacts.kind, "app"),
            isNull(artifacts.deletedAt),
            eq(artifacts.workspaceId, run.workspaceId)
          )
        )
        .limit(1);
      // An app without a live version has nothing to receive a reply.
      if (!app?.currentVersionId) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          invoke(
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
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("App reply timed out")),
              30_000
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
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
  const schedule = (work: () => Promise<void>) => {
    // Own every rejection, including lookup and failure-event storage errors.
    const pending = Promise.resolve()
      .then(work)
      .catch(() => undefined);
    defer?.(pending);
  };
  const gateway: Gateway = {
    deliver: (target, message, context) => {
      if (target.kind === "app") {
        schedule(() =>
          deliver(target, context.runId, {
            ...message,
            status: "finished",
          })
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
    const { runId } = event;
    schedule(async () => {
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
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
    });
    return Promise.resolve();
  };
  return { gateway, onEvent };
};
