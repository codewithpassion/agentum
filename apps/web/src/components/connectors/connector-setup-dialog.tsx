import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/field";
import {
  addConnector,
  type Connector,
  reauthorizeConnector,
  type StartOutcome,
  setConnectorBearer,
  setConnectorOauthClient,
} from "#/lib/api";
import { openBlankPopup, waitForAuthorization } from "./oauth-popup";

/**
 * The add-connector ladder as a dialog (plan 4b): paste a URL, and the server's
 * probe decides which rung the human lands on - straight in, a popup, a manual
 * client id, or a pasted bearer token. Each rung is a step here rather than its
 * own dialog, because the connector row exists from the first step onwards and
 * every rung acts on that same row.
 *
 * Re-authorizing is the same ladder without its first rung, so it is this
 * dialog seeded with a connector rather than a second implementation.
 */

/** The plan's warning: an API key is usually the wrong key to paste here. */
const BEARER_WARNING =
  "Hosted MCP servers usually want an OAuth access token, not the service's own API key. Paste an API key here only if this server's documentation says to send it as a bearer token.";

type Step =
  | { kind: "url" }
  | { connector: Connector; kind: "resume" }
  | { authorizeUrl: string; connector: Connector; kind: "waiting" }
  | { connector: Connector; issuer: string; kind: "client" }
  | { connector: Connector; kind: "bearer"; message: string | null };

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

function StepNote({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[var(--ws-muted)] text-xs">{children}</p>;
}

function StepError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return <p className="m-0 text-[var(--ws-danger)] text-xs">{message}</p>;
}

export function ConnectorSetupDialog({
  connector,
  onClose,
  onDone,
  open,
}: {
  /** Null adds a new connector; a row re-authorizes that one. */
  connector: Connector | null;
  onClose: () => void;
  /** Runs before the dialog closes, so the caller can refetch. */
  onDone: (connector: Connector) => Promise<void>;
  open: boolean;
}) {
  const [step, setStep] = useState<Step>({ kind: "url" });
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setStep(connector ? { connector, kind: "resume" } : { kind: "url" });
    setUrl("");
    setName("");
    setClientId("");
    setClientSecret("");
    setToken("");
    setError(null);
  }, [connector, open]);

  const finish = useCallback(
    async (settled: Connector) => {
      await onDone(settled);
      onClose();
    },
    [onClose, onDone]
  );

  const runAuthorize = useCallback(
    async (row: Connector, authorizeUrl: string, popup: Window | null) => {
      popup?.location.replace(authorizeUrl);
      setStep({ authorizeUrl, connector: row, kind: "waiting" });
      const settled = await waitForAuthorization(row.id);
      if (settled.status === "connected") {
        await finish(settled);
        return;
      }
      setError(
        settled.lastError ?? "The authorization did not complete. Try again."
      );
    },
    [finish]
  );

  const handleOutcome = useCallback(
    async (row: Connector, outcome: StartOutcome, popup: Window | null) => {
      if (outcome.kind === "authorize") {
        await runAuthorize(row, outcome.authorizeUrl, popup);
        return;
      }
      // Every other rung is answered in this dialog, so the blank popup opened
      // for the click is now just in the way.
      popup?.close();
      if (outcome.kind === "connected") {
        await finish(row);
        return;
      }
      if (outcome.kind === "needs_client") {
        setStep({ connector: row, issuer: outcome.issuer, kind: "client" });
        return;
      }
      setStep({ connector: row, kind: "bearer", message: outcome.message });
    },
    [finish, runAuthorize]
  );

  /** One busy flag, one error slot, and the popup opened inside the gesture. */
  const run = useCallback(
    (work: (popup: Window | null) => Promise<void>, wantsPopup: boolean) => {
      // Opened here rather than after the await: a browser refuses a popup
      // requested outside the click that asked for it (see oauth-popup.ts).
      const popup = wantsPopup ? openBlankPopup() : null;
      setBusy(true);
      setError(null);
      (async () => {
        try {
          await work(popup);
        } catch (cause) {
          popup?.close();
          setError(messageOf(cause, "That did not work."));
        } finally {
          setBusy(false);
        }
      })();
    },
    []
  );

  const submitUrl = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      run(async (popup) => {
        const added = await addConnector({
          ...(name.trim() ? { name: name.trim() } : {}),
          url: url.trim(),
        });
        await handleOutcome(added.connector, added.outcome, popup);
      }, true);
    },
    [handleOutcome, name, run, url]
  );

  const submitClient = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (step.kind !== "client") {
        return;
      }
      const row = step.connector;
      run(async (popup) => {
        const outcome = await setConnectorOauthClient(row.id, {
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim() || null,
        });
        await handleOutcome(row, outcome, popup);
      }, true);
    },
    [clientId, clientSecret, handleOutcome, run, step]
  );

  const submitBearer = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (step.kind !== "bearer") {
        return;
      }
      const row = step.connector;
      run(async () => {
        await finish(await setConnectorBearer(row.id, token.trim()));
      }, false);
    },
    [finish, run, step, token]
  );

  const startAuthorize = useCallback(() => {
    if (step.kind === "url") {
      return;
    }
    const row = step.connector;
    run(async (popup) => {
      const outcome = await reauthorizeConnector(row.id);
      await handleOutcome(row, outcome, popup);
    }, true);
  }, [handleOutcome, run, step]);

  const switchToBearer = useCallback(() => {
    if (step.kind === "url") {
      return;
    }
    setError(null);
    setStep({ connector: step.connector, kind: "bearer", message: null });
  }, [step]);

  const onUrlChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setUrl(event.target.value),
    []
  );
  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const onClientIdChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setClientId(event.target.value),
    []
  );
  const onClientSecretChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setClientSecret(event.target.value),
    []
  );
  const onTokenChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setToken(event.target.value),
    []
  );

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={connector ? `Re-authorize ${connector.name}` : "Add connector"}
    >
      {step.kind === "url" ? (
        <form className="space-y-4" onSubmit={submitUrl}>
          <TextField
            hint="The server's MCP endpoint. We probe it and ask for whatever it needs."
            label="Server URL"
            onChange={onUrlChange}
            placeholder="https://mcp.example.com/mcp"
            required
            value={url}
          />
          <TextField
            hint="Defaults to the server's hostname, which two servers on one host would share."
            label="Name (optional)"
            maxLength={120}
            onChange={onNameChange}
            placeholder="Linear"
            value={name}
          />
          <StepError message={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button disabled={busy} type="submit" variant="primary">
              {busy ? "Checking…" : "Add connector"}
            </Button>
          </div>
        </form>
      ) : null}

      {step.kind === "resume" ? (
        <div className="space-y-4">
          <StepNote>
            This signs in to {step.connector.url} again and replaces the stored
            credential. Running sessions keep the one they already have.
          </StepNote>
          <StepError message={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={switchToBearer} variant="ghost">
              Use a bearer token instead
            </Button>
            <Button disabled={busy} onClick={startAuthorize} variant="primary">
              {busy ? "Starting…" : "Re-authorize"}
            </Button>
          </div>
        </div>
      ) : null}

      {step.kind === "waiting" ? (
        <div className="space-y-4">
          <p className="m-0 text-sm" data-testid="connector-authorizing">
            Finish signing in to <strong>{step.connector.name}</strong> in the
            window that opened.
          </p>
          <StepNote>
            This closes itself once the server sends us back. If no window
            opened,{" "}
            <a
              className="text-[var(--ws-accent)]"
              href={step.authorizeUrl}
              rel="noopener"
              target="_blank"
            >
              open the authorization page
            </a>
            .
          </StepNote>
          <StepError message={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={switchToBearer} variant="ghost">
              Use a bearer token instead
            </Button>
            <Button disabled={busy} onClick={startAuthorize}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {step.kind === "client" ? (
        <form className="space-y-4" onSubmit={submitClient}>
          <StepNote>
            {step.issuer} does not register clients automatically. Create one in
            its settings with the redirect URI{" "}
            <code className="font-mono text-[11px]">
              {`${window.location.origin}/api/connectors/oauth/callback`}
            </code>
            , then paste its id here.
          </StepNote>
          <TextField
            label="Client id"
            onChange={onClientIdChange}
            required
            value={clientId}
          />
          <TextField
            hint="Only for confidential clients - leave it empty otherwise."
            label="Client secret (optional)"
            onChange={onClientSecretChange}
            type="password"
            value={clientSecret}
          />
          <StepError message={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={switchToBearer} variant="ghost">
              Use a bearer token instead
            </Button>
            <Button disabled={busy} type="submit" variant="primary">
              Continue
            </Button>
          </div>
        </form>
      ) : null}

      {step.kind === "bearer" ? (
        <form className="space-y-4" onSubmit={submitBearer}>
          {step.message ? <StepNote>{step.message}</StepNote> : null}
          <p className="m-0 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-muted)] text-xs">
            {BEARER_WARNING}
          </p>
          <TextField
            label="Bearer token"
            onChange={onTokenChange}
            required
            type="password"
            value={token}
          />
          <StepError message={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button disabled={busy} type="submit" variant="primary">
              Save token
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
