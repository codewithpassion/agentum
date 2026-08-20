import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { type ExecView, latestExec } from "#/lib/agent-screen";
import type { BrowserStatus, Screenshot } from "#/lib/api";
import { formatRelativeTime } from "#/lib/format";
import { usePolling } from "#/lib/use-agent-screen";
import { useApi } from "#/lib/workspace-context";

/**
 * The right rail's Screen tab: what the agent is looking at (its browser's last
 * screenshot and page) and what it last ran (the newest `computer.exec` in its
 * activity log). It polls rather than listening on a socket, because the
 * computer and the browser write from tool calls that belong to no channel.
 */

/** Deep enough to find the last command under a burst of file writes. */
const EXEC_SCAN_LIMIT = 20;

type ScreenState =
  | {
      browser: BrowserStatus;
      exec: ExecView | null;
      screenshot: Screenshot | null;
      status: "ready";
    }
  | { message: string; status: "error" };

function Unreachable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="space-y-2 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-3 text-center"
      data-testid="agent-screen-error"
    >
      <p className="m-0 font-medium text-[13px]">Can't reach agent's screen</p>
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">{message}</p>
      <Button onClick={onRetry} size="sm" variant="subtle">
        Retry
      </Button>
    </div>
  );
}

function ScreenshotCard({
  onZoom,
  screenshot,
}: {
  onZoom: () => void;
  screenshot: Screenshot;
}) {
  return (
    <figure className="m-0 space-y-1.5">
      <button
        className="ws-focus block w-full cursor-zoom-in overflow-hidden rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)] p-0"
        onClick={onZoom}
        type="button"
      >
        {/* biome-ignore lint/correctness/useImageSize: screenshots carry no stored dimensions; the box bounds the render */}
        <img
          alt={`${screenshot.title || screenshot.pageUrl} screenshot`}
          className="block w-full"
          src={screenshot.url}
        />
      </button>
      {/* The page it is of is the line below, which the browser status owns. */}
      <figcaption className="m-0 text-[var(--ws-muted)] text-xs">
        {formatRelativeTime(screenshot.createdAt)}
      </figcaption>
    </figure>
  );
}

function BrowserLine({ browser }: { browser: BrowserStatus }) {
  if (!browser.available) {
    return (
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        No browser is attached to this deployment.
      </p>
    );
  }
  if (!browser.currentUrl) {
    return (
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        The browser has not opened a page yet.
      </p>
    );
  }
  return (
    <p className="m-0 text-xs leading-5" data-testid="agent-screen-url">
      <span className="text-[var(--ws-muted)]">
        {browser.sessionActive ? "Browsing" : "Last page"}:{" "}
      </span>
      <span className="break-all">{browser.currentUrl}</span>
    </p>
  );
}

function Stream({ danger, text }: { danger?: boolean; text: string }) {
  if (!text) {
    return null;
  }
  return (
    <pre
      className={`m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 ${danger ? "text-[var(--ws-danger)]" : "text-[var(--ws-text)]"}`}
    >
      {text}
    </pre>
  );
}

function TerminalCard({ exec }: { exec: ExecView }) {
  return (
    <section
      className="space-y-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)] p-2 font-mono"
      data-testid="agent-screen-exec"
    >
      <p className="m-0 break-all text-[11px] text-[var(--ws-accent)] leading-5">
        <span aria-hidden="true">$ </span>
        {exec.command}
      </p>
      <Stream text={exec.stdout} />
      <Stream danger text={exec.stderr} />
      {exec.error ? <Stream danger text={exec.error} /> : null}
      {exec.exitCode !== null && exec.exitCode !== 0 ? (
        <p className="m-0 text-[11px] text-[var(--ws-danger)]">
          exit {exec.exitCode}
        </p>
      ) : null}
    </section>
  );
}

function ReadyScreen({
  onZoom,
  state,
}: {
  onZoom: () => void;
  state: Extract<ScreenState, { status: "ready" }>;
}) {
  const bare = !(state.screenshot || state.exec || state.browser.currentUrl);

  if (bare) {
    return (
      <div
        className="space-y-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-3 text-center"
        data-testid="agent-screen-empty"
      >
        <p className="m-0 font-medium text-[13px]">Nothing on screen yet</p>
        <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
          Screenshots and command output appear here as soon as the agent uses
          its browser or its computer.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {state.screenshot ? (
        <ScreenshotCard onZoom={onZoom} screenshot={state.screenshot} />
      ) : null}
      <BrowserLine browser={state.browser} />
      {state.exec ? <TerminalCard exec={state.exec} /> : null}
    </div>
  );
}

export function AgentScreenTab({
  agentId,
  pollMs,
}: {
  agentId: string;
  pollMs: number;
}) {
  const api = useApi();

  const [state, setState] = useState<ScreenState | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api.listBrowserScreenshots(agentId, 1),
      api.getBrowserStatus(agentId),
      api.listAgentActivity(agentId, { limit: EXEC_SCAN_LIMIT }),
    ])
      .then(([shots, browser, activity]) => {
        setState({
          browser,
          exec: latestExec(activity.entries),
          screenshot: shots.screenshots[0] ?? null,
          status: "ready",
        });
      })
      .catch((cause: unknown) => {
        setState({
          message:
            cause instanceof Error
              ? cause.message
              : "The agent's computer and browser did not answer.",
          status: "error",
        });
      });
  }, [agentId, api]);

  usePolling(load, pollMs);

  const openZoom = useCallback(() => setZoomed(true), []);
  const closeZoom = useCallback(() => setZoomed(false), []);

  const screenshot = state?.status === "ready" ? state.screenshot : null;

  return (
    <div className="space-y-3" data-testid="agent-screen">
      {state === null ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">Loading…</p>
      ) : null}
      {state?.status === "error" ? (
        <Unreachable message={state.message} onRetry={load} />
      ) : null}
      {state?.status === "ready" ? (
        <ReadyScreen onZoom={openZoom} state={state} />
      ) : null}

      <Dialog
        onClose={closeZoom}
        open={zoomed && screenshot !== null}
        title={screenshot?.title || "Screenshot"}
      >
        {screenshot ? (
          <div className="space-y-2">
            {/* biome-ignore lint/correctness/useImageSize: screenshots carry no stored dimensions; the dialog bounds the render */}
            <img
              alt={`${screenshot.title || screenshot.pageUrl} screenshot`}
              className="block w-full rounded-lg border border-[var(--ws-line)]"
              src={screenshot.url}
            />
            <p className="m-0 break-all text-[var(--ws-muted)] text-xs">
              {screenshot.pageUrl}
            </p>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
