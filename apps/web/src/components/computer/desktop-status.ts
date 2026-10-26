// What the live screen says about itself: who holds the desktop, why there is
// no picture, and whether the viewer may ask for control. Pure, so the panel
// stays a thin drawing of these answers.

import type { DesktopProblem, DesktopStatus } from "./desktop-stream.ts";

export type Connection = "connecting" | "open" | "reconnecting";

/** The line above the screen: who holds the desktop right now. */
export const controllerLabel = (status: DesktopStatus | null): string => {
  if (status === null) {
    return "Connecting…";
  }
  if (status.youHaveControl) {
    return "You are in control";
  }
  if (status.control === null) {
    return "Nobody is in control";
  }
  return status.control.holder.kind === "agent"
    ? "The agent is in control"
    : "Another person is in control";
};

const withReason = (text: string, reason: string): string =>
  reason === "" ? text : `${text}: ${reason}`;

const problemText = (problem: DesktopProblem): string => {
  switch (problem.kind) {
    case "human_in_control":
      return "Another person is controlling this desktop. The view comes back when they hand it back.";
    case "clearing":
      return "Clearing the last person's clipboard…";
    case "offline":
      return "Computer offline";
    case "unavailable":
      return withReason("Desktop unavailable", problem.message);
    default:
      return problem.message || "The desktop failed";
  }
};

/** Why the view is not live, or null while it is. */
export const notLiveText = ({
  connection,
  problem,
  status,
}: {
  connection: Connection;
  problem: DesktopProblem | null;
  status: DesktopStatus | null;
}): string | null => {
  if (status !== null && !status.connected) {
    return "Computer offline";
  }
  if (status !== null && !status.desktop) {
    return withReason(
      "Desktop unavailable",
      status.desktopUnavailableReason ?? ""
    );
  }
  if (problem !== null) {
    return problemText(problem);
  }
  if (connection === "reconnecting") {
    return "Connection lost. Reconnecting…";
  }
  return null;
};

/** The agent asked for a person and the desktop is free of anyone else. */
export const canTakeOver = ({
  hasTakeover,
  status,
}: {
  hasTakeover: boolean;
  status: DesktopStatus | null;
}): boolean => {
  if (!hasTakeover || status === null) {
    return false;
  }
  const free =
    status.control === null || status.control.holder.kind === "agent";
  return status.connected && status.desktop && !status.youHaveControl && free;
};
