import {
  MessagePrimitive,
  type TextMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import {
  ThreadCard,
  threadCardArtifactOf,
} from "#/components/artifacts/thread-card.tsx";
import { Markdown } from "#/components/markdown/markdown.tsx";
import { RequestCard } from "#/components/requests/request-card.tsx";
import { Bubble, BubbleContent } from "#/components/ui/bubble.tsx";
import { Message, MessageContent } from "#/components/ui/message.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { FileChips } from "./file-chips.tsx";
import { ReasoningContainer, ReasoningPart } from "./reasoning-container.tsx";
import { RunMarker } from "./run-marker.tsx";
import { FilesLine, RunFailure } from "./thread-cards.tsx";
import { useThreadEnv } from "./thread-context.tsx";
import {
  ToolCallContainer,
  ToolGroupContainer,
} from "./tool-call-container.tsx";

function TextPart({ text }: TextMessagePartProps) {
  return (
    <Bubble className="w-full max-w-full" variant="ghost">
      <BubbleContent className="w-full overflow-visible">
        <Markdown>{text}</Markdown>
      </BubbleContent>
    </Bubble>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A request part: the approval or question card of the task page, found by request id. */
function RequestPart({ data }: { data: unknown }) {
  const {
    answer,
    nowMs,
    requests,
    inControl,
    canTake,
    onComputer,
    editedRuns,
    requestTimes,
  } = useThreadEnv();
  const id = isRecord(data) ? data.requestId : undefined;
  const view = typeof id === "string" ? requests.get(id) : undefined;
  return view === undefined || nowMs === null ? null : (
    <div
      data-request-pending={view.settled === null}
      id={`thread-request-${view.id}`}
      tabIndex={-1}
    >
      <RequestCard
        cancelledByEdit={editedRuns?.has(view.runId)}
        canTake={canTake}
        inControl={inControl}
        nowMs={nowMs}
        onAnswer={answer}
        onComputer={onComputer}
        settledAt={requestTimes?.get(view.id)}
        view={view}
      />
    </div>
  );
}

/** A file the agent made: a chip with "Save to library", or the path when the file id is not known. */
function AttachmentPart({ data }: { data: unknown }) {
  const { agentName, files } = useThreadEnv();
  if (!isRecord(data)) {
    return null;
  }
  if (typeof data.fileId === "string") {
    return (
      <FileChips agentName={agentName} fileIds={[data.fileId]} files={files} />
    );
  }
  return typeof data.path === "string" ? (
    <p className="text-muted-foreground text-xs">Attached: {data.path}</p>
  ) : null;
}

/** An artifact the agent published: a card with a live preview, keyed on the part. */
function ArtifactPart({ data }: { data: unknown }) {
  const artifact = threadCardArtifactOf(data);
  return artifact === null ? null : <ThreadCard artifact={artifact} />;
}

function StatusLine() {
  const status = useAuiState((state) => state.message.status);
  if (status === undefined) {
    return null;
  }
  if (status.type === "running") {
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Spinner className="size-3" /> Working
      </p>
    );
  }
  if (status.type === "requires-action") {
    return (
      <p className="text-muted-foreground text-xs">Waiting for an answer</p>
    );
  }
  if (status.type === "incomplete") {
    return (
      <p className="text-muted-foreground text-xs">
        {status.reason === "cancelled" ? "Cancelled" : "Failed"}
      </p>
    );
  }
  return null;
}

/** An agent turn: text, reasoning, tool cards and request cards, in the order they happened. */
export function AssistantMessageContainer() {
  const id = useAuiState((state) => state.message.id);
  const { failure, filesLine, requests } = useThreadEnv();
  const runId = useAuiState((state) => state.message.metadata.custom.runId);
  const requestIds = useAuiState((state) =>
    state.message.content
      .filter((part) => part.type === "data" && part.name === "request")
      .map((part) =>
        "data" in part && isRecord(part.data) ? String(part.data.requestId) : ""
      )
      .join("\u0000")
  );
  const missingRequests = [...requests.values()].filter(
    (view) =>
      view.runId === runId && !requestIds.split("\u0000").includes(view.id)
  );
  return (
    <MessagePrimitive.Root data-role="assistant">
      <RunMarker>
        <Message align="start">
          <MessageContent>
            <MessagePrimitive.Parts
              components={{
                data: {
                  by_name: {
                    artifact: ArtifactPart,
                    attachment: AttachmentPart,
                    request: RequestPart,
                  },
                },
                Reasoning: ReasoningPart,
                ReasoningGroup: ReasoningContainer,
                Text: TextPart,
                ToolGroup: ToolGroupContainer,
                tools: { Fallback: ToolCallContainer },
              }}
            />
            {missingRequests.map((view) => (
              <RequestPart data={{ requestId: view.id }} key={view.id} />
            ))}
            {failure?.messageId === id ? (
              <RunFailure error={failure.error} />
            ) : (
              <StatusLine />
            )}
            {filesLine?.messageId === id ? (
              <FilesLine
                onConflicts={filesLine.onConflicts}
                onOpen={filesLine.onOpen}
                text={filesLine.text}
              />
            ) : null}
          </MessageContent>
        </Message>
      </RunMarker>
    </MessagePrimitive.Root>
  );
}
