import type { Db } from "#/db/client";
import { logActivity } from "#/modules/activity/service";
import type { Agent } from "#/modules/agents/schema";
import { browserScreenshots } from "#/modules/browser/schema";
import { type DesktopFailureReason, takeDesktopScreenshot } from "./desktop";

/**
 * A picture of the agent's desktop for the `desktop_screenshot` custom tool:
 * capture through the host's relay, keep the JPEG in R2, list it in the rail,
 * log it. Only agents on the managed runtime whose host reported a desktop in
 * its hello are offered the tool (`anthropic/service` decides at sync time).
 */

const HEX_RADIX = 16;
const NONCE_BYTES = 4;
const BYTE_HEX_LENGTH = 2;

const nonce = (): string => {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(HEX_RADIX).padStart(BYTE_HEX_LENGTH, "0"))
    .join("");
};

export const desktopScreenshotKey = (
  agentId: string,
  takenAt: number
): string => `desktop/${agentId}/${takenAt}-${nonce()}.jpg`;

/** Written for the model: each says what to do next, not only what went wrong. */
export const desktopFailureText = (
  reason: DesktopFailureReason,
  message: string
): string => {
  switch (reason) {
    case "human_in_control":
      return "A person is using the desktop right now. Do not retry; tell the user you are waiting for them to hand it back.";
    case "desktop_busy":
      return "Another session is using this computer's desktop. Do not retry now; finish what you can with exec, or tell the user the desktop is busy.";
    case "desktop_unavailable":
      return `The desktop on this computer is not running (${message}). The desktop tools will not work; use exec instead.`;
    case "offline":
    case "unreachable":
      return `${message} The desktop cannot be seen until the computer is back; use exec if you can, or tell the user.`;
    case "timeout":
      return "The computer did not return a screenshot in time. Try once more; if it fails again, tell the user.";
    case "revoked":
      return "This computer's access was revoked, so the desktop is gone. Tell the user.";
    default:
      return message;
  }
};

export type DesktopCapture =
  | {
      base64: string;
      height: number;
      mediaType: "image/jpeg";
      ok: true;
      width: number;
    }
  | { ok: false; text: string };

const BASE64_CHUNK = 0x80_00;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
};

/** Never throws for a failed capture; the text is written for the model. */
export const captureDesktop = async (
  db: Db,
  env: Env,
  agent: Agent
): Promise<DesktopCapture> => {
  if (!agent.computerHostId) {
    return { ok: false, text: "This agent has no computer host." };
  }
  const relay = env.COMPUTER_RELAY.get(
    env.COMPUTER_RELAY.idFromName(agent.computerHostId)
  );
  const shot = await takeDesktopScreenshot(relay, null, agent.id);
  if (!shot.ok) {
    return { ok: false, text: desktopFailureText(shot.reason, shot.message) };
  }

  const createdAt = new Date();
  const r2Key = desktopScreenshotKey(agent.id, createdAt.getTime());
  await env.ATTACHMENTS.put(r2Key, shot.data, {
    httpMetadata: { contentType: shot.mediaType },
  });
  // The same index the browser's screenshots use, so the rail lists it.
  await db.insert(browserScreenshots).values({
    agentId: agent.id,
    createdAt,
    id: crypto.randomUUID(),
    pageUrl: "desktop",
    r2Key,
    size: shot.data.byteLength,
    title: "Desktop",
  });

  const size = `${String(shot.width)}x${String(shot.height)}`;
  await logActivity(db, {
    agentId: agent.id,
    detail: { height: shot.height, r2Key, width: shot.width },
    kind: "computer.desktop",
    summary: `screenshot ${size}`,
  });

  return {
    base64: toBase64(shot.data),
    height: shot.height,
    mediaType: shot.mediaType,
    ok: true,
    width: shot.width,
  };
};
