import {
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  DesktopScreenshotRequestSchema,
  DesktopScreenshotResultPayloadSchema,
} from "./protocol";
import type { ComputerPrincipal, RelayOutcome } from "./relay";

/**
 * The server half of `computer_screenshot`: one `desktop_screenshot` op through
 * the host's `ComputerRelay`, answered with the JPEG's bytes or a failure the
 * tool can word for the model. Never throws; a relay that rejects is reported
 * as `unreachable`.
 */

/** What the relay stub offers; a fake in tests is just this one method. */
export interface DesktopRelay {
  request: (
    message: Record<string, unknown>,
    principal?: ComputerPrincipal
  ) => Promise<RelayOutcome>;
}

export type DesktopFailureReason =
  | "desktop_busy"
  | "desktop_unavailable"
  | "error"
  | "human_in_control"
  | "offline"
  | "revoked"
  | "timeout"
  | "unreachable";

export type DesktopScreenshot =
  | {
      data: Uint8Array;
      height: number;
      mediaType: "image/jpeg";
      ok: true;
      width: number;
    }
  | { message: string; ok: false; reason: DesktopFailureReason };

const DEFAULT_QUALITY = 60;
const BAD_REPLY =
  "The computer sent a screenshot this server could not understand. Check that its version matches this deployment.";
const UNREACHABLE = "The computer host could not be reached.";

export const fromBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  bytes.set(Array.from(binary, (character) => character.charCodeAt(0)));
  return bytes;
};

/** A daemon error code, or a relay refusal, folded into the reasons the tool words. */
const reasonOf = (outcome: RelayOutcome): DesktopFailureReason => {
  const key: string = outcome.code ?? outcome.reason ?? "";
  switch (key) {
    case "desktop_busy":
    case "desktop_unavailable":
    case "human_in_control":
    case "offline":
    case "revoked":
    case "timeout":
      return key;
    case "stale":
    case "replaced":
    case "interrupted":
      return "offline";
    default:
      return "error";
  }
};

/** `agentId` names the agent the screenshot is for; without it the lease holder is unnamed. */
export const takeDesktopScreenshot = async (
  relay: DesktopRelay,
  quality: number | null = null,
  agentId?: string
): Promise<DesktopScreenshot> => {
  const request = DesktopScreenshotRequestSchema.parse({
    op: "desktop_screenshot",
    quality: quality ?? DEFAULT_QUALITY,
  });

  let outcome: RelayOutcome;
  try {
    outcome = await relay.request(
      {
        ...request,
        id: crypto.randomUUID(),
        timeout_ms: DESKTOP_SCREENSHOT_TIMEOUT_MS,
      },
      agentId === undefined ? undefined : { agentId, kind: "agent" }
    );
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : UNREACHABLE,
      ok: false,
      reason: "unreachable",
    };
  }

  if (!outcome.ok) {
    return { message: outcome.message, ok: false, reason: reasonOf(outcome) };
  }

  try {
    const payload = DesktopScreenshotResultPayloadSchema.parse(
      JSON.parse(outcome.result_json ?? "{}")
    );
    return {
      data: fromBase64(payload.data_b64),
      height: payload.height,
      mediaType: payload.media_type,
      ok: true,
      width: payload.width,
    };
  } catch {
    return { message: BAD_REPLY, ok: false, reason: "error" };
  }
};
