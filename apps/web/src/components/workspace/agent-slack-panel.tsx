import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import type { SlackApp } from "#/lib/api";
import { slackConnectHint, slackWizardStep } from "#/lib/slack-wizard";
import { useApi } from "#/lib/workspace-context";

/**
 * The Slack connection wizard (docs/plan-slack-apps-per-agent.md, "Wizard UX"):
 * one panel whose step is derived from the agent's `slack_apps` row, so closing
 * the dialog half way through and coming back resumes rather than restarts.
 *
 * Create → the draft exists only so the manifest can name its events URL.
 * Connect → the manifest to paste into Slack, then the two credentials back.
 * Done → where it is connected, and how to disconnect.
 */

const COPIED_RESET_MS = 1500;

/** Slack's own wording, so the panel matches the screens it is talking about. */
const CLICK_PATH = [
  "Open api.slack.com/apps",
  "Create New App",
  "From a manifest",
  "Pick the Slack workspace this agent should live in",
  "Paste the manifest below",
  "Create",
  "Install to Workspace",
] as const;

type PanelState =
  | { manifest: string | null; slackApp: SlackApp | null; status: "ready" }
  | { message: string; status: "error" }
  | { status: "loading" };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function ManifestBlock({
  defaultOpen,
  manifest,
}: {
  defaultOpen: boolean;
  manifest: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(manifest).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [manifest]);

  return (
    <details
      className="space-y-2 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-2"
      data-testid="slack-manifest-block"
      open={defaultOpen}
    >
      <summary className="ws-focus cursor-pointer font-medium text-[13px]">
        App manifest and setup steps
      </summary>
      <ol className="m-0 mt-2 list-decimal space-y-1 pl-5 text-[var(--ws-muted)] text-xs leading-5">
        {CLICK_PATH.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        The request URL in the manifest verifies itself the moment you paste —
        there is nothing to confirm afterwards.
      </p>
      <div className="flex justify-end">
        <Button
          data-testid="slack-manifest-copy"
          onClick={copy}
          size="sm"
          variant="subtle"
        >
          {copied ? "Copied" : "Copy manifest"}
        </Button>
      </div>
      <pre
        className="m-0 max-h-56 overflow-auto whitespace-pre rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)] p-2 font-mono text-[11px] leading-5"
        data-testid="slack-manifest"
      >
        {manifest}
      </pre>
    </details>
  );
}

function CreateStep({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="slack-step-create">
      <p className="m-0 text-[13px] leading-6">Connect this agent to Slack</p>
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        This agent gets its own Slack app, so in Slack it is itself — its own
        name, avatar and mentions. We generate the manifest; you paste it into
        Slack and hand back the two credentials it gives you.
      </p>
      <Button
        data-testid="slack-create-app"
        disabled={busy}
        onClick={onCreate}
        size="sm"
        variant="primary"
      >
        Create the Slack app
      </Button>
    </div>
  );
}

function ConnectStep({
  busy,
  justCreated,
  manifest,
  onSubmit,
  slackApp,
}: {
  busy: boolean;
  /** Freshly created apps show the manifest open; a resumed one starts folded. */
  justCreated: boolean;
  manifest: string | null;
  onSubmit: (input: { botToken: string; signingSecret: string }) => void;
  slackApp: SlackApp;
}) {
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");

  const changeBotToken = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setBotToken(event.target.value),
    []
  );
  const changeSigningSecret = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setSigningSecret(event.target.value),
    []
  );
  // Trimmed on the way out: these are pasted, and a trailing newline would come
  // back from Slack as an `invalid_auth` nobody could explain.
  const submit = useCallback(
    () =>
      onSubmit({
        botToken: botToken.trim(),
        signingSecret: signingSecret.trim(),
      }),
    [botToken, onSubmit, signingSecret]
  );

  return (
    <div className="space-y-3" data-testid="slack-step-connect">
      {manifest ? (
        <ManifestBlock defaultOpen={justCreated} manifest={manifest} />
      ) : null}

      {slackApp.lastError ? (
        <p
          className="m-0 text-[var(--ws-danger)] text-xs leading-5"
          data-testid="slack-last-error"
        >
          {slackApp.lastError}
        </p>
      ) : null}

      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        {slackConnectHint(slackApp)}
      </p>

      <TextField
        autoComplete="off"
        data-testid="slack-bot-token"
        hint="OAuth & Permissions → Bot User OAuth Token"
        label="Bot User OAuth Token"
        onChange={changeBotToken}
        placeholder="xoxb-…"
        spellCheck={false}
        value={botToken}
      />
      <TextField
        autoComplete="off"
        data-testid="slack-signing-secret"
        hint="Basic Information → App Credentials → Signing Secret"
        label="Signing Secret"
        onChange={changeSigningSecret}
        spellCheck={false}
        value={signingSecret}
      />

      <Button
        data-testid="slack-save-tokens"
        disabled={
          busy ||
          botToken.trim().length === 0 ||
          signingSecret.trim().length === 0
        }
        onClick={submit}
        size="sm"
        variant="primary"
      >
        Connect
      </Button>
    </div>
  );
}

/**
 * Confirmation is inline rather than a `ConfirmDialog`: this panel already
 * lives inside the agent's settings dialog, and React reports a nested
 * `<dialog>`'s close on the outer one too - which shut the whole settings
 * dialog the moment the confirmation was answered.
 */
function DisconnectConfirm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="space-y-2 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-2"
      data-testid="slack-disconnect-confirm"
    >
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        This agent stops being a Slack app, and the channel bridges that go
        through it are removed with it.
      </p>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button
          data-testid="slack-disconnect-confirmed"
          disabled={busy}
          onClick={onConfirm}
          size="sm"
          variant="danger"
        >
          Disconnect anyway
        </Button>
      </div>
    </div>
  );
}

function DoneStep({
  busy,
  confirming,
  onCancelDisconnect,
  onConfirmDisconnect,
  onDisconnect,
  slackApp,
}: {
  busy: boolean;
  confirming: boolean;
  onCancelDisconnect: () => void;
  onConfirmDisconnect: () => void;
  onDisconnect: () => void;
  slackApp: SlackApp;
}) {
  return (
    <div className="space-y-3" data-testid="slack-step-done">
      <p className="m-0 flex items-center gap-1.5 text-[13px]">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--ws-accent)" }}
        />
        Connected to{" "}
        <span className="font-medium">{slackApp.teamName ?? "Slack"}</span>
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        Bot user <code className="text-[11px]">{slackApp.botUserId}</code>
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        Next, run{" "}
        <code className="text-[11px]">{`/invite <@${slackApp.botUserId}>`}</code>{" "}
        in each Slack channel you want it in, then bridge those channels from
        their own Settings here.
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        Created this app before question buttons shipped? Re-apply the manifest
        from step 2 in Slack — without it Slack never delivers a button click.
      </p>
      {confirming ? (
        <DisconnectConfirm
          busy={busy}
          onCancel={onCancelDisconnect}
          onConfirm={onConfirmDisconnect}
        />
      ) : (
        <Button
          data-testid="slack-disconnect"
          disabled={busy}
          onClick={onDisconnect}
          size="sm"
          variant="danger"
        >
          Disconnect
        </Button>
      )}
    </div>
  );
}

export function AgentSlackPanel({ agentId }: { agentId: string }) {
  const api = useApi();

  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getAgentSlackApp(agentId)
      .then((data) => {
        if (!cancelled) {
          setState({
            manifest: data.slackApp ? data.manifest : null,
            slackApp: data.slackApp,
            status: "ready",
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ message: errorMessage(cause), status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, api]);

  const create = useCallback(() => {
    (async () => {
      setBusy(true);
      setActionError(null);
      try {
        const created = await api.createAgentSlackApp(agentId);
        setJustCreated(true);
        setState({
          manifest: created.manifest,
          slackApp: created.slackApp,
          status: "ready",
        });
      } catch (cause) {
        setActionError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [agentId, api]);

  const saveTokens = useCallback(
    (input: { botToken: string; signingSecret: string }) => {
      (async () => {
        setBusy(true);
        setActionError(null);
        try {
          const saved = await api.saveAgentSlackTokens(agentId, input);
          setJustCreated(false);
          setState((current) =>
            current.status === "ready"
              ? { ...current, slackApp: saved }
              : current
          );
        } catch (cause) {
          // Slack's own error string ("invalid_auth", "account_inactive", …),
          // which is what makes a rejected paste fixable.
          setActionError(errorMessage(cause));
        } finally {
          setBusy(false);
        }
      })();
    },
    [agentId, api]
  );

  const askDisconnect = useCallback(() => setConfirming(true), []);
  const cancelDisconnect = useCallback(() => setConfirming(false), []);

  const disconnect = useCallback(() => {
    (async () => {
      setBusy(true);
      setActionError(null);
      try {
        await api.deleteAgentSlackApp(agentId);
        setConfirming(false);
        setJustCreated(false);
        setState({ manifest: null, slackApp: null, status: "ready" });
      } catch (cause) {
        setActionError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [agentId, api]);

  if (state.status === "loading") {
    return <p className="m-0 text-[var(--ws-muted)] text-xs">Loading…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="m-0 text-[var(--ws-danger)] text-xs">{state.message}</p>
    );
  }

  const step = slackWizardStep(state.slackApp);

  return (
    // The manifest is long enough that the panel, not the dialog, is what
    // scrolls - otherwise the token form ends up below the bottom of the screen.
    <div
      className="max-h-[70vh] space-y-3 overflow-y-auto"
      data-testid="agent-slack-panel"
    >
      {step === "create" ? <CreateStep busy={busy} onCreate={create} /> : null}

      {step === "connect" && state.slackApp ? (
        <ConnectStep
          busy={busy}
          justCreated={justCreated}
          manifest={state.manifest}
          onSubmit={saveTokens}
          slackApp={state.slackApp}
        />
      ) : null}

      {step === "done" && state.slackApp ? (
        <DoneStep
          busy={busy}
          confirming={confirming}
          onCancelDisconnect={cancelDisconnect}
          onConfirmDisconnect={disconnect}
          onDisconnect={askDisconnect}
          slackApp={state.slackApp}
        />
      ) : null}

      {actionError ? (
        <p
          className="m-0 text-[var(--ws-danger)] text-xs leading-5"
          data-testid="slack-action-error"
        >
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
