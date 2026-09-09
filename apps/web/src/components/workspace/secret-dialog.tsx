import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/field";
import type { Secret } from "#/lib/api";
import {
  addHostChip,
  hintLabel,
  SECRET_VALUE_MAX_LENGTH,
  SECRET_VALUE_MIN_LENGTH,
} from "#/lib/secrets-format";
import { useApi } from "#/lib/workspace-context";
// Straight from the allowlist rules, so the cap cannot drift from the server's.
import { MAX_ALLOWED_HOSTS } from "#/modules/secrets/hosts";

/**
 * Storing a credential, rotating one, and editing everything about one that is
 * not the credential itself. Three modes rather than three dialogs, because
 * they are the same form with different parts of it showing.
 *
 * `name` is in none of them but "add": agents and sandboxes address a secret by
 * name, so a rename is a delete and a create, and the API refuses one outright.
 * Everything else the endpoint accepts is editable here - a service that moves
 * to a new hostname should be a changed allowlist, not a new secret with every
 * grant dropped.
 *
 * The value is a password field that is never read back. Nothing here can show
 * it again - there is no endpoint that returns one - so the only thing an owner
 * ever sees afterwards is the hint.
 */

export type SecretDialogMode = "add" | "edit" | "rotate";

const NAME_PATTERN = "[A-Z][A-Z0-9_]{1,63}";

/** Said in the add form, because it is the failure the design cannot prevent. */
const UNSUPPORTED_NOTE =
  "This sends the value as a request header. A credential you have to sign with rather than send - AWS SigV4, an HMAC webhook secret - cannot be used this way, on either runtime. For a token-exchange flow, do the exchange outside and store the token it returns.";

const TITLES: Record<SecretDialogMode, string> = {
  add: "Add a secret",
  edit: "Edit",
  rotate: "Rotate",
};

const ACTIONS: Record<SecretDialogMode, string> = {
  add: "Add secret",
  edit: "Save changes",
  rotate: "Rotate",
};

function HostField({
  hosts,
  onChange,
  pending,
  setPending,
}: {
  hosts: string[];
  onChange: (hosts: string[]) => void;
  pending: string;
  setPending: (value: string) => void;
}) {
  // Anthropic's cap on a vault credential's allowed hosts, which the server
  // enforces for every secret; refusing the seventeenth here is friendlier than
  // refusing the whole save.
  const atCap = hosts.length >= MAX_ALLOWED_HOSTS;

  const add = useCallback(() => {
    if (atCap) {
      return;
    }
    onChange(addHostChip(hosts, pending));
    setPending("");
  }, [atCap, hosts, onChange, pending, setPending]);

  const onPendingChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setPending(event.target.value),
    [setPending]
  );

  // Enter must not submit the form while a host is half-typed, and a comma is
  // how anyone who has ever filled in a list of hosts expects to end one.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        add();
      }
    },
    [add]
  );

  const remove = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const { host } = event.currentTarget.dataset;
      onChange(hosts.filter((entry) => entry !== host));
    },
    [hosts, onChange]
  );

  return (
    <div className="space-y-1.5">
      <TextField
        autoCapitalize="off"
        autoComplete="off"
        disabled={atCap}
        hint={
          atCap
            ? `${MAX_ALLOWED_HOSTS} hosts is the most a secret can have. Remove one to add another.`
            : "Where this secret may be sent. One host per entry, or a *.example.com wildcard. Anywhere else is refused before the request is made."
        }
        label="Allowed hosts"
        onChange={onPendingChange}
        onKeyDown={onKeyDown}
        placeholder="api.deepgram.com"
        spellCheck={false}
        value={pending}
      />
      {hosts.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {hosts.map((host) => (
            <li key={host}>
              <span className="inline-flex items-center gap-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2 py-0.5 text-xs">
                {host}
                <button
                  aria-label={`Remove ${host}`}
                  className="ws-focus text-[var(--ws-muted)] hover:text-[var(--ws-text)]"
                  data-host={host}
                  onClick={remove}
                  type="button"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AdvancedFields({
  description,
  header,
  headerPrefix,
  onDescriptionChange,
  onHeaderChange,
  onHeaderPrefixChange,
  open,
}: {
  description: string;
  header: string;
  headerPrefix: string;
  onDescriptionChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onHeaderChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onHeaderPrefixChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Open when editing: the fields are the point of the form, not a detour. */
  open: boolean;
}) {
  return (
    <details
      className="rounded-lg border border-[var(--ws-line)] px-3 py-2"
      open={open}
    >
      <summary className="ws-focus cursor-pointer font-medium text-[var(--ws-muted)] text-xs">
        Advanced
      </summary>
      <div className="space-y-3 pt-3">
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          The request is sent as{" "}
          <code>
            {header || "Authorization"}: {headerPrefix}
            {"<value>"}
          </code>
          . Deepgram wants <code>Authorization</code> with the prefix{" "}
          <code>Token </code> (the trailing space matters); an API that wants{" "}
          <code>x-api-key</code> wants no prefix at all.
        </p>
        <TextField
          autoCapitalize="off"
          autoComplete="off"
          label="Header"
          onChange={onHeaderChange}
          placeholder="Authorization"
          spellCheck={false}
          value={header}
        />
        <TextField
          autoCapitalize="off"
          autoComplete="off"
          hint="What precedes the value. Keep the trailing space."
          label="Header prefix"
          onChange={onHeaderPrefixChange}
          placeholder="Bearer "
          spellCheck={false}
          value={headerPrefix}
        />
        <TextField
          hint="Shown to agents that hold this secret, so they know what it is for."
          label="Description"
          onChange={onDescriptionChange}
          placeholder="Speech-to-text for call recordings."
          value={description}
        />
      </div>
    </details>
  );
}

export function SecretDialog({
  mode,
  onClose,
  onSaved,
  open,
  secret,
}: {
  mode: SecretDialogMode;
  onClose: () => void;
  onSaved: () => Promise<void>;
  open: boolean;
  /** Present for "edit" and "rotate"; absent when adding. */
  secret: Secret | null;
}) {
  const api = useApi();

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState<string[]>([]);
  const [pendingHost, setPendingHost] = useState("");
  const [header, setHeader] = useState("");
  const [headerPrefix, setHeaderPrefix] = useState("Bearer ");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editing starts from what is stored; adding starts from the defaults the
  // server would apply anyway.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName("");
    setValue("");
    setPendingHost("");
    setError(null);
    if (secret) {
      setHosts([...secret.allowedHosts]);
      setHeader(secret.header);
      setHeaderPrefix(secret.headerPrefix);
      setDescription(secret.description);
      return;
    }
    setHosts([]);
    setHeader("");
    setHeaderPrefix("Bearer ");
    setDescription("");
  }, [open, secret]);

  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setName(event.target.value.toUpperCase()),
    []
  );
  const onValueChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setValue(event.target.value),
    []
  );
  const onHeaderChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setHeader(event.target.value),
    []
  );
  const onHeaderPrefixChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setHeaderPrefix(event.target.value),
    []
  );
  const onDescriptionChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setDescription(event.target.value),
    []
  );

  // A host typed but not yet turned into a chip is still a host the owner
  // meant, so it goes in rather than being silently dropped.
  const allowedHosts = addHostChip(hosts, pendingHost);

  const save = useCallback(async () => {
    if (mode === "add") {
      await api.createSecret({
        allowedHosts,
        description: description || undefined,
        header: header || undefined,
        headerPrefix,
        name,
        value,
      });
      return;
    }
    if (!secret) {
      return;
    }
    await api.updateSecret(
      secret.id,
      mode === "rotate"
        ? { value }
        : { allowedHosts, description, header, headerPrefix }
    );
  }, [
    allowedHosts,
    api,
    description,
    header,
    headerPrefix,
    mode,
    name,
    secret,
    value,
  ]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        await save();
        await onSaved();
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save.");
      } finally {
        setBusy(false);
      }
    },
    [onClose, onSaved, save]
  );

  const rotating = mode === "rotate";
  // The server refuses an empty allowlist - a secret with no hosts can never be
  // used - so the button says so first.
  const noHosts = !rotating && allowedHosts.length === 0;

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={secret ? `${TITLES[mode]} ${secret.name}` : TITLES[mode]}
    >
      <form className="space-y-4" onSubmit={submit}>
        {mode === "add" ? (
          <TextField
            autoCapitalize="off"
            autoComplete="off"
            hint="Environment-variable style: capitals, digits and underscores. Agents use this name, and it cannot be changed later."
            label="Name"
            maxLength={64}
            onChange={onNameChange}
            pattern={NAME_PATTERN}
            placeholder="DEEPGRAM_API_KEY"
            required
            spellCheck={false}
            value={name}
          />
        ) : null}

        {rotating && secret ? (
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            The stored value ends {hintLabel(secret.hint)}. Pasting a new one
            replaces it everywhere at once, including the sandboxes of the
            agents that hold it.
          </p>
        ) : null}

        {mode === "edit" ? null : (
          <TextField
            autoComplete="off"
            hint={`At least ${SECRET_VALUE_MIN_LENGTH} characters. Stored encrypted and never shown again - not to you, and never to an agent.`}
            label="Value"
            maxLength={SECRET_VALUE_MAX_LENGTH}
            minLength={SECRET_VALUE_MIN_LENGTH}
            onChange={onValueChange}
            placeholder="Paste the key"
            required
            spellCheck={false}
            type="password"
            value={value}
          />
        )}

        {rotating ? null : (
          <>
            <HostField
              hosts={hosts}
              onChange={setHosts}
              pending={pendingHost}
              setPending={setPendingHost}
            />

            <AdvancedFields
              description={description}
              header={header}
              headerPrefix={headerPrefix}
              onDescriptionChange={onDescriptionChange}
              onHeaderChange={onHeaderChange}
              onHeaderPrefixChange={onHeaderPrefixChange}
              open={mode === "edit"}
            />
          </>
        )}

        {mode === "add" ? (
          <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
            {UNSUPPORTED_NOTE}
          </p>
        ) : null}

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy || noHosts} type="submit" variant="primary">
            {ACTIONS[mode]}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
