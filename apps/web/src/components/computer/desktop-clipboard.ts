// The remote clipboard, over the viewer routes `GET` and `PUT
// /api/machines/:id/desktop/clipboard`. Failures answer `{ error, message }`.

const clipboardPath = (machineId: string): string =>
  `/api/machines/${encodeURIComponent(machineId)}/desktop/clipboard`;

const failureMessage = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return `The clipboard request failed (${String(response.status)})`;
};

/** The text on the remote desktop's clipboard. */
export const readRemoteClipboard = async (
  machineId: string
): Promise<string> => {
  const response = await fetch(clipboardPath(machineId));
  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("text" in body) ||
    typeof body.text !== "string"
  ) {
    throw new Error("The computer sent a clipboard reply this app cannot read");
  }
  return body.text;
};

/** Puts text on the remote desktop's clipboard. */
export const writeRemoteClipboard = async (
  machineId: string,
  text: string
): Promise<void> => {
  const response = await fetch(clipboardPath(machineId), {
    body: JSON.stringify({ text }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }
};
