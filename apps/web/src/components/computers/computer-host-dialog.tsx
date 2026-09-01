import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { SelectField, TextField } from "#/components/ui/field";
import type {
  ComputerHost,
  ComputerHostConfig,
  ComputerHostKind,
} from "#/lib/api";
import { COMPUTER_HOST_KIND_LABELS } from "#/lib/computer-hosts";
import { useApi } from "#/lib/workspace-context";
import { ComputerTokenPanel } from "./computer-token-panel";

/**
 * Adding a computer host: pick which of the two backends it is, fill in what
 * that backend needs, and - for a self-hosted container - leave with the
 * command that pairs it. The two forms have nothing in common but the name,
 * which is why the kind is the first field rather than a tab.
 */

const DEFAULT_CPUS = "1";
const DEFAULT_MEMORY_MB = "512";
const DEFAULT_VOLUME_GB = "10";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

const isComputerHostKind = (value: string): value is ComputerHostKind =>
  value === "fly" || value === "self_hosted";

/** Blank means "let the server decide"; a number only travels when given. */
const numberOr = (value: string): number | undefined => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) ? undefined : parsed;
};

interface FlyDraft {
  app: string;
  cpus: string;
  memoryMb: string;
  region: string;
  token: string;
  volumeGb: string;
}

const EMPTY_FLY: FlyDraft = {
  app: "",
  cpus: DEFAULT_CPUS,
  memoryMb: DEFAULT_MEMORY_MB,
  region: "",
  token: "",
  volumeGb: DEFAULT_VOLUME_GB,
};

const flyConfig = (draft: FlyDraft): ComputerHostConfig => {
  const cpus = numberOr(draft.cpus);
  const memory_mb = numberOr(draft.memoryMb);
  const volume_gb = numberOr(draft.volumeGb);
  const instance = {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memory_mb === undefined ? {} : { memory_mb }),
  };
  return {
    app: draft.app.trim(),
    ...(draft.region.trim() === "" ? {} : { region: draft.region.trim() }),
    ...(volume_gb === undefined ? {} : { volume_gb }),
    ...(Object.keys(instance).length === 0 ? {} : { instance }),
  };
};

function FlyForm({
  draft,
  onChange,
}: {
  draft: FlyDraft;
  onChange: (patch: Partial<FlyDraft>) => void;
}) {
  const set = useCallback(
    (key: keyof FlyDraft) => (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ [key]: event.target.value }),
    [onChange]
  );

  return (
    <>
      <TextField
        hint="A Fly app you have already created, with a shared IPv4/IPv6 allocated so <app>.fly.dev resolves. Agentum creates machines and volumes in it, but never the app itself."
        label="Fly app"
        onChange={set("app")}
        placeholder="my-agents"
        required
        value={draft.app}
      />
      <TextField
        hint="Where the machines and their volumes live, e.g. iad, fra, syd. Blank lets Fly choose."
        label="Region"
        onChange={set("region")}
        placeholder="iad"
        value={draft.region}
      />
      <TextField
        autoComplete="off"
        hint="An app-scoped deploy token: fly tokens create deploy -a <app>. It is stored encrypted and never shown again."
        label="Fly API token"
        onChange={set("token")}
        placeholder="FlyV1 …"
        required
        type="password"
        value={draft.token}
      />
      <div className="grid grid-cols-3 gap-2">
        <TextField
          label="CPUs"
          min={1}
          onChange={set("cpus")}
          type="number"
          value={draft.cpus}
        />
        <TextField
          label="Memory (MB)"
          min={256}
          onChange={set("memoryMb")}
          step={256}
          type="number"
          value={draft.memoryMb}
        />
        <TextField
          label="Volume (GB)"
          min={1}
          onChange={set("volumeGb")}
          type="number"
          value={draft.volumeGb}
        />
      </div>
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        Each agent on this host gets its own machine and volume. Fly starts a
        stopped machine on the first command and stops it again when it goes
        idle; you are billed for the seconds it runs.
      </p>
    </>
  );
}

function SelfHostedForm() {
  return (
    <p className="m-0 text-[var(--ws-muted)] text-xs">
      A self-hosted host is one container on a machine you run. There is nothing
      else to configure here — the next screen has the command to start it, with
      a token that is shown once. One container is one agent's computer; run a
      second container with its own token for a second agent.
    </p>
  );
}

export function ComputerHostDialog({
  onClose,
  onDone,
  open,
}: {
  onClose: () => void;
  /** Runs before the dialog closes, so the caller can refetch or navigate. */
  onDone: (host: ComputerHost) => Promise<void>;
  open: boolean;
}) {
  const api = useApi();

  const [kind, setKind] = useState<ComputerHostKind>("self_hosted");
  const [name, setName] = useState("");
  const [fly, setFly] = useState<FlyDraft>(EMPTY_FLY);
  const [issued, setIssued] = useState<{
    host: ComputerHost;
    token: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setKind("self_hosted");
    setName("");
    setFly(EMPTY_FLY);
    setIssued(null);
    setError(null);
  }, [open]);

  const onKindChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      if (isComputerHostKind(event.target.value)) {
        setKind(event.target.value);
      }
    },
    []
  );
  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const onFlyChange = useCallback(
    (patch: Partial<FlyDraft>) =>
      setFly((previous) => ({ ...previous, ...patch })),
    []
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const created = await api.createComputerHost({
          kind,
          name: name.trim(),
          ...(kind === "fly"
            ? { config: flyConfig(fly), flyApiToken: fly.token }
            : {}),
        });
        // A self-hosted host's token exists in this response and nowhere else,
        // so the dialog stays open on it. The caller is told only when that
        // screen is dismissed (`finish`): it navigates to the host's page,
        // which is a different route, and a route change remounts this dialog
        // - telling it now would drop the token before anyone could copy it.
        // A Fly host has no token to show and closes straight away.
        if (created.token) {
          setIssued({ host: created.host, token: created.token });
          return;
        }
        await onDone(created.host);
        onClose();
      } catch (cause) {
        setError(messageOf(cause, "Failed to add this host."));
      } finally {
        setBusy(false);
      }
    },
    [api, fly, kind, name, onClose, onDone]
  );

  // Leaving the token screen by any route - the Done button, Escape, the
  // close button - hands the host to the caller: it exists whether or not
  // the token was copied, and the list and navigation must say so.
  const finish = useCallback(async () => {
    if (issued) {
      await onDone(issued.host);
    }
    onClose();
  }, [issued, onClose, onDone]);

  return (
    <Dialog
      onClose={issued ? finish : onClose}
      open={open}
      title={issued ? `Start ${issued.host.name}` : "Add computer host"}
    >
      {issued ? (
        <div className="space-y-4">
          <ComputerTokenPanel token={issued.token} />
          <div className="flex justify-end">
            <Button onClick={finish} variant="primary">
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <SelectField
            data-testid="computer-host-kind"
            hint={
              kind === "fly"
                ? "A Fly app of yours. Agentum creates one machine and one volume per agent in it."
                : "A container you run yourself, on hardware you choose. It dials out to Agentum, so it needs no public address."
            }
            label="Kind"
            onChange={onKindChange}
            value={kind}
          >
            <option value="self_hosted">
              {COMPUTER_HOST_KIND_LABELS.self_hosted}
            </option>
            <option value="fly">{COMPUTER_HOST_KIND_LABELS.fly}</option>
          </SelectField>

          <TextField
            label="Name"
            maxLength={120}
            onChange={onNameChange}
            placeholder={kind === "fly" ? "prod-machines" : "office-box"}
            required
            value={name}
          />

          {kind === "fly" ? (
            <FlyForm draft={fly} onChange={onFlyChange} />
          ) : (
            <SelfHostedForm />
          )}

          {error ? (
            <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button disabled={busy} type="submit" variant="primary">
              Add host
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
