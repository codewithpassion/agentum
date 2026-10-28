import type { LivePort } from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import type { LiveCommentThread } from "@repo/protocol/live";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose";
import { guarded } from "./guarded";

const documentToolError = (result: {
  code: string;
  current?: unknown;
  message?: string;
}) => {
  const codes: Record<string, string> = {
    ambiguous_find: "find_ambiguous",
    comment_anchor: "anchor_conflict",
  };
  const code = codes[result.code] ?? result.code;
  const mapped = [
    "forbidden",
    "guard_mismatch",
    "block_gone",
    "find_none",
    "find_ambiguous",
    "anchor_conflict",
  ].includes(code)
    ? (code as
        | "forbidden"
        | "guard_mismatch"
        | "block_gone"
        | "find_none"
        | "find_ambiguous"
        | "anchor_conflict")
    : "validation";
  return new ToolError(
    mapped,
    `${code}${result.current ? `: ${JSON.stringify(result.current)}` : ""}${result.message ? `: ${result.message}` : ""}`
  );
};
export const createLivePorts = ({
  principal,
  services,
  publicBaseUrl,
  toolCallId,
}: {
  principal: Principal;
  services: Services;
  publicBaseUrl?: string;
  toolCallId?: string;
}): LivePort => {
  const service = () => {
    if (!services.liveArtifacts) {
      throw new ToolError("validation", "Live documents are unavailable");
    }
    return services.liveArtifacts;
  };
  const room = async (artifactId: string) => {
    if (!services.liveRoom) {
      throw new ToolError("validation", "Live rooms are unavailable");
    }
    return await services.liveRoom(principal, artifactId);
  };
  const present = async <T>(
    artifactId: string,
    status: string,
    action: (stub: Awaited<ReturnType<typeof room>>) => Promise<T>
  ) => {
    const stub = await room(artifactId);
    if (principal.kind !== "run") {
      return action(stub);
    }
    const identity = await service().roomIdentity(principal, artifactId);
    const heartbeat = () =>
      stub.setAgentPresence({
        color: identity.color,
        id: identity.participantId,
        kind: "agent",
        name: identity.name,
        status,
      });
    await heartbeat();
    const timer = setInterval(() => {
      heartbeat().catch(() => undefined);
    }, 2000);
    try {
      return await action(stub);
    } finally {
      clearInterval(timer);
      await stub.setAgentPresence(null);
    }
  };
  const thread = (value: unknown) => value as LiveCommentThread;
  const loadThread = async (
    artifactId: string,
    threadId: string | undefined
  ) => {
    let cursor: string | undefined;
    do {
      // biome-ignore lint/performance/noAwaitInLoops: follow the authorized page cursor.
      const page = await service().threads(principal, {
        artifactId,
        cursor,
        limit: 100,
      });
      const found = page.items.find((t) => t.id === threadId);
      if (found) {
        return thread(found);
      }
      cursor = page.next;
    } while (cursor);
    throw new ToolError("not_found", "Thread not found");
  };
  return {
    comment: (input) =>
      guarded(() =>
        present(input.artifactId, "Commenting", async (stub) => {
          if (input.answered && input.threadId) {
            await service().answered(principal, { threadId: input.threadId });
          }
          if (input.body !== undefined) {
            const anchor = input.quote
              ? await stub.documentAnchor({
                  blockId: input.blockId,
                  nth: input.nth,
                  quote: input.quote,
                })
              : undefined;
            const comment = await service().comment(principal, {
              anchor,
              artifactId: input.artifactId,
              body: input.body,
              requestId: crypto.randomUUID(),
              threadId: input.threadId,
              toAgent: input.to === "agent",
            });
            return {
              comment,
              thread: await loadThread(input.artifactId, comment.threadId),
            };
          }
          return { thread: await loadThread(input.artifactId, input.threadId) };
        })
      ),
    comments: (input) =>
      guarded(() =>
        present(input.artifactId, "Reading comments", async () => {
          const page = await service().threads(principal, {
            artifactId: input.artifactId,
            cursor: input.cursor,
            inbox: input.to === "agent" && input.answered === false,
          });
          return {
            items: page.items
              .filter(
                (t) =>
                  (input.to === undefined || t.toAgent) &&
                  (input.answered === undefined ||
                    Boolean(t.answeredAt) === input.answered)
              )
              .map(thread),
            next: page.next,
          };
        })
      ),
    create: (input) =>
      guarded(async () => {
        const result = await service().createDocument(principal, input);
        return {
          artifactId: result.artifactId,
          revision: result.revision,
          url: `${publicBaseUrl ?? ""}/a/${result.artifactId}`,
        };
      }),
    edit: (input) =>
      guarded(() =>
        present(input.artifactId, input.status ?? "Editing", async (stub) => {
          if (principal.kind !== "run") {
            throw new ToolError("forbidden", "A running agent is required");
          }
          const identity = await service().roomIdentity(
            principal,
            input.artifactId
          );
          const callId = toolCallId ?? crypto.randomUUID();
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`${principal.runId}:${callId}`)
            )
          );
          const changeId = [...digest]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const result = await stub.documentEdit(
            input.ops,
            {
              changeId,
              mode: "direct",
              participantId: identity.participantId,
              runId: principal.runId,
              toolCallId: callId,
            },
            input.summary ?? "Edit document"
          );
          if (!result.ok) {
            throw documentToolError(result);
          }
          // The room retains stable change metadata before mutation; checkpoint retry
          // reconciles this row even if the request dies before the immediate save.
          await stub.checkpoint();
          return {
            changeId: result.changeId,
            revision: result.revision,
            skipped: [],
            status: "status" in result ? result.status : undefined,
            suggestionId:
              "suggestionId" in result ? result.suggestionId : undefined,
          };
        })
      ),
    read: (input) =>
      guarded(() =>
        present(input.artifactId, "Reading", async (stub) => {
          const result = await stub.documentRead(input);
          return { ...result, artifactId: input.artifactId };
        })
      ),
  };
};
