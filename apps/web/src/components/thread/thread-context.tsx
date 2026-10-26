import { createContext, useContext } from "react";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import type { FileInfo } from "#/integrations/trpc/types.ts";

/** What the thread's containers read from the task page: the data behind the parts that assistant-ui only has ids for. */
export interface ThreadEnv {
  agentName: string;
  answer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  /** The latest user message, the only one that can be edited. Null when there is none or the thread is read only. */
  editableId: string | null;
  /** Ids of user messages that were edited and resent. */
  edited: ReadonlySet<string>;
  files: ReadonlyMap<string, FileInfo>;
  /** Null until mounted, so the server and browser markup match. */
  nowMs: number | null;
  requests: ReadonlyMap<string, RequestView>;
}

const ThreadEnvContext = createContext<ThreadEnv | null>(null);

export const ThreadEnvProvider = ThreadEnvContext.Provider;

export const useThreadEnv = (): ThreadEnv => {
  const env = useContext(ThreadEnvContext);
  if (env === null) {
    throw new Error("useThreadEnv needs a ThreadEnvProvider above it.");
  }
  return env;
};
