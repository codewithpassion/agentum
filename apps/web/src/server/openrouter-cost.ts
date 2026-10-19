import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Records the cost OpenRouter reports for a streamed response. */
export interface CostProbe {
  /** The latest valid reported cost in USD, or undefined when none was seen. */
  cost: () => number | undefined;
  /** Feeds one parsed stream chunk to the probe. */
  observe: (data: unknown) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isReportedCost = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Keeps the `usage.cost` of the latest chunk that carries a valid one. The
 * probe stores only the number, never the chunk.
 */
export const createCostProbe = (): CostProbe => {
  let latest: number | undefined;
  return {
    cost: () => latest,
    observe(data) {
      const usage = isRecord(data) ? data.usage : undefined;
      if (!(isRecord(usage) && isReportedCost(usage.cost))) {
        return;
      }
      latest = usage.cost;
    },
  };
};

const applyReportedCost = (
  message: AssistantMessage,
  probe: CostProbe
): void => {
  const cost = probe.cost();
  if (cost !== undefined) {
    message.usage.cost.total = cost;
  }
};

/**
 * Forwards every event of `source` unchanged. Final `done` and `error`
 * messages get the probe's reported cost as `usage.cost.total` first. If the
 * source throws, the returned stream ends so its consumers do not hang.
 */
export const withReportedCost = (
  source: AssistantMessageEventStream,
  probe: CostProbe
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  const forward = async (): Promise<void> => {
    for await (const event of source) {
      if (event.type === "done") {
        applyReportedCost(event.message, probe);
      } else if (event.type === "error") {
        applyReportedCost(event.error, probe);
      }
      stream.push(event);
    }
  };
  forward()
    .catch(() => undefined)
    .finally(() => stream.end());
  return stream;
};
