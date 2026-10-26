// The tools a cloud run gets for its agent's computer, over the platform's own
// ports and not over MCP: `desktop_screenshot`, which returns the picture as an
// image block, and `request_human_takeover`, which waits inside the call for a
// person to hand the computer back (`pi-run-gate.ts` makes it). Only a computer
// that reports a desktop gets them. Kept free of `cloudflare:workers` so bun can
// test it; `pi-run.ts` stores the computer from `CloudStart` and installs it.
import { Type } from "@earendil-works/pi-ai";
import type {
  Extension,
  Registry,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PortResult, ToolImage } from "@repo/mcp/ports";

/** The extension's name in the registry. */
export const COMPUTER_EXTENSION = "hm-computer";

export const DESKTOP_SCREENSHOT_TOOL = "desktop_screenshot";

/** The agent's computer as `CloudStart` gives it, kept so a wake installs the same tools. */
export interface StoredComputer {
  desktop: boolean;
  machineId: string;
}

export interface ComputerToolDeps {
  /** A picture of the machine's desktop for the run's agent. */
  screenshot: (machineId: string) => Promise<PortResult<{ image: ToolImage }>>;
  /** `request_human_takeover`, from the gate. */
  takeover: ToolRegistration;
}

const SCREENSHOT_DESCRIPTION =
  "Take a picture of the computer's desktop. The picture comes back in the result.";

/** What the model reads when no picture could be taken. */
const failureText = (failure: { code: string; reason?: string }): string =>
  failure.reason ??
  `The desktop screenshot failed (${failure.code}). Try again, or go on without it.`;

const screenshotTool = (
  machineId: string,
  screenshot: ComputerToolDeps["screenshot"]
): ToolRegistration => ({
  description: SCREENSHOT_DESCRIPTION,
  execute: async () => {
    try {
      const shot = await screenshot(machineId);
      if (!shot.ok) {
        return {
          isError: true,
          output: [{ text: failureText(shot), type: "text" }],
        };
      }
      return {
        isError: false,
        output: [
          {
            data: shot.image.data,
            mimeType: shot.image.mimeType,
            type: "image",
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        output: [
          {
            text: `The desktop screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
            type: "text",
          },
        ],
      };
    }
  },
  name: DESKTOP_SCREENSHOT_TOOL,
  parameters: Type.Object({}),
  // A picture changes nothing, so it may be taken again after a restart.
  replay: "safe",
});

/** The extension for a computer, or nothing for one without a desktop. */
export const computerExtension = (
  computer: StoredComputer | undefined,
  deps: ComputerToolDeps
): Extension | undefined =>
  computer?.desktop
    ? {
        name: COMPUTER_EXTENSION,
        tools: [
          screenshotTool(computer.machineId, deps.screenshot),
          deps.takeover,
        ],
      }
    : undefined;

/**
 * Gives the session the computer tools, or takes them out. An extension that
 * stays is installed over itself and keeps its place, because Pi lists the tools
 * in install order and a different order makes it re-declare every tool.
 */
export const installComputer = (
  registry: Pick<Registry, "install" | "uninstall">,
  computer: StoredComputer | undefined,
  deps: ComputerToolDeps
): void => {
  const extension = computerExtension(computer, deps);
  if (extension) {
    registry.install(extension);
  } else {
    registry.uninstall({ name: COMPUTER_EXTENSION });
  }
};
