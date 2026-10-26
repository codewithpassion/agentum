// The `browser` group of the platform MCP tools: the calling run's own browser,
// over the browser service. Service refusals become typed failures the agent
// can act on; anything else goes through `guarded` as a tool error.
import type { BrowserPort, PortFailure, PortResult } from "@repo/mcp/ports";
import type { BrowserService } from "@repo/services/browser";
import { isServiceError, type ServiceErrorCode } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import { bytesToBase64 } from "./base64.ts";
import { guarded } from "./guarded.ts";

const FAILURE_CODES: Record<ServiceErrorCode, PortFailure["code"]> = {
  conflict: "offline",
  invalid: "validation",
  not_found: "not_found",
};

/** Runs `work` and returns its fields as a successful port result, or a typed failure for a service refusal. */
const settle = <T extends object>(
  work: () => Promise<T>
): Promise<PortResult<T>> =>
  guarded(async () => {
    try {
      return { ok: true, ...(await work()) };
    } catch (error) {
      if (isServiceError(error)) {
        return {
          code: FAILURE_CODES[error.code],
          ok: false,
          reason: error.message,
        };
      }
      throw error;
    }
  });

export const createBrowserPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: { browser: BrowserService };
}): BrowserPort => {
  const { browser } = services;
  return {
    click: ({ selector }) =>
      settle(async () => ({
        snapshot: await browser.click(principal, selector),
      })),
    fill: ({ selector, value }) =>
      settle(async () => {
        const filled = await browser.fill(principal, selector, value);
        return { selector: filled.selector ?? selector, url: filled.url };
      }),
    navigate: ({ url }) =>
      settle(async () => ({
        snapshot: await browser.navigate(principal, url),
      })),
    screenshot: () =>
      settle(async () => {
        const shot = await browser.screenshot(principal);
        return {
          image: {
            data: bytesToBase64(shot.bytes),
            mimeType: "image/png",
          },
          pageUrl: shot.pageUrl,
        };
      }),
    snapshot: () =>
      settle(async () => ({ snapshot: await browser.snapshot(principal) })),
  };
};
