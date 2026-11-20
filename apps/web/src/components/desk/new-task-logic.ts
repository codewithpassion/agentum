/** The body `runs.start` takes when the New conversation dialog starts a task. */
export interface StartTaskBody {
  agentId: string;
  input: { fileIds: string[]; text: string };
  requestId: string;
  session: { origin: "ui"; private: boolean };
}

/** Builds the start body. The text is trimmed; the dialog sends no files. */
export const startTaskBody = ({
  agentId,
  isPrivate,
  requestId,
  text,
}: {
  agentId: string;
  isPrivate: boolean;
  requestId: string;
  text: string;
}): StartTaskBody => ({
  agentId,
  input: { fileIds: [], text: text.trim() },
  requestId,
  session: { origin: "ui", private: isPrivate },
});
