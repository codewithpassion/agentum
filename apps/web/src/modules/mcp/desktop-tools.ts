import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "#/db/client";
import { logActivity } from "#/modules/activity/service";
import type { Agent } from "#/modules/agents/schema";
import { browserScreenshots } from "#/modules/browser/schema";
import {
  type DesktopFailureReason,
  takeDesktopScreenshot,
} from "#/modules/computer/desktop";
import { getHostByIdUnscoped } from "#/modules/computer/hosts";
import { fail, jsonWithImage } from "./format";
import type { McpToolContext } from "./tools";

/**
 * `computer_screenshot`: a picture of the agent's desktop, returned in the
 * tool result as an image block. Only agents on the managed runtime whose
 * host reported a desktop in its hello are offered it, so `agentHasDesktop`
 * decides before the tool is registered.
 */

/** Whether this agent can be offered the desktop tool. */
export const agentHasDesktop = async (
  db: Db,
  agent: Agent
): Promise<boolean> => {
  if (agent.runtime !== "managed" || !agent.computerHostId) {
    return false;
  }
  const host = await getHostByIdUnscoped(db, agent.computerHostId);
  return host?.capabilities?.desktop === true;
};

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

export const registerDesktopTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "computer_screenshot",
    {
      description:
        "Take a screenshot of your computer's desktop. The picture comes back in the result.",
      inputSchema: {},
      title: "Screenshot the desktop",
    },
    async () => {
      const { agent, db, env } = ctx;
      if (!agent.computerHostId) {
        return fail("This agent has no computer host.");
      }
      const relay = env.COMPUTER_RELAY.get(
        env.COMPUTER_RELAY.idFromName(agent.computerHostId)
      );
      const shot = await takeDesktopScreenshot(relay);
      if (!shot.ok) {
        return fail(desktopFailureText(shot.reason, shot.message));
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

      return jsonWithImage(
        { height: shot.height, width: shot.width },
        { bytes: shot.data, mimeType: shot.mediaType }
      );
    }
  );
};
