import type { StatusBand } from "@repo/db/shared";
import type { EventRecord } from "../events.ts";
import type { RequestRecord } from "../requests.ts";
import type { RunRecord } from "../runs/types.ts";
import { payloadOf, requestDetail, sentence, toolWords } from "./format.ts";

type PendingRequest = Pick<RequestRecord, "kind" | "status" | "toolName"> & {
  display: unknown;
};

/** Terminal bands deliberately need no event history. Pending records are in caller order. */
export const statusBand = (
  run: Pick<RunRecord, "status" | "resultText" | "error">,
  events: readonly EventRecord[],
  pending: readonly PendingRequest[]
): StatusBand => {
  switch (run.status) {
    case "done":
      return { text: sentence(run.resultText, "Done"), tone: "ok" };
    case "failed":
    case "interrupted":
      return {
        text: sentence(
          run.error,
          run.status === "failed" ? "Run failed" : "Run interrupted"
        ),
        tone: "error",
      };
    case "cancelled":
      return { text: "Run cancelled", tone: "ok" };
    case "queued":
    case "offered":
      return { text: "Waiting to start", tone: "waiting" };
    case "waiting": {
      const request = pending.find((entry) => entry.status === "pending");
      if (!request) {
        return { text: "Waiting for a response", tone: "waiting" };
      }
      const label =
        request.kind === "approval"
          ? "Waiting for approval"
          : "Waiting for an answer";
      const detail =
        requestDetail(request.display) ||
        (request.kind === "approval" ? toolWords(request.toolName) : "");
      return {
        text: sentence(detail ? `${label}: ${detail}` : label, label),
        tone: "waiting",
      };
    }
    default: {
      // An assistant message closes the preceding activity; until another call, show Thinking.
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type === "message.assistant") {
          break;
        }
        if (event?.type === "tool.call") {
          return {
            text: sentence(toolWords(payloadOf(event).name), "Thinking"),
            tone: "running",
          };
        }
      }
      return { text: "Thinking", tone: "running" };
    }
  }
};
