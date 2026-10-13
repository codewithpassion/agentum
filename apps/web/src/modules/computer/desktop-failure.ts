import { CLIENT_ERROR_DESKTOP_UNAVAILABLE } from "./protocol";
import type { RelayOutcome } from "./relay";

export const LEASE_REQUIRED_MESSAGE = "Take control of the desktop first.";

/** What a route answers a failed relay op with: the status, and the code the UI branches on. */
export interface Failure {
  readonly error: string;
  readonly message: string;
  readonly status: 409 | 423 | 502 | 503;
}

export const relayFailure = (outcome: RelayOutcome): Failure => {
  switch (outcome.reason) {
    case "human_in_control":
      return {
        error: "human_in_control",
        message: outcome.message,
        status: 423,
      };
    case "forbidden":
      return {
        error: "lease_required",
        message: LEASE_REQUIRED_MESSAGE,
        status: 423,
      };
    case "desktop_busy":
      return { error: "clearing", message: outcome.message, status: 409 };
    case "desktop_unavailable":
      return {
        error: "desktop_unavailable",
        message: outcome.message,
        status: 503,
      };
    case "client_error":
      if (outcome.code === CLIENT_ERROR_DESKTOP_UNAVAILABLE) {
        return {
          error: "desktop_unavailable",
          message: outcome.message,
          status: 503,
        };
      }
      return { error: "desktop_failed", message: outcome.message, status: 502 };
    default:
      return { error: "offline", message: outcome.message, status: 503 };
  }
};
