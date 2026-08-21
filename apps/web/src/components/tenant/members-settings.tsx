import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import type {
  AnthropicKeyStatus,
  ExternalAuthorView,
  MemberSearchResult,
  MemberView,
} from "#/lib/api";
import { memberLabel } from "#/lib/authors";
import { formatDay } from "#/lib/format";
import { useActiveWorkspace } from "#/lib/workspace-context";
import {
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "#/modules/workspaces/schema";

const AVATAR_COLOR = "#52525b";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

function Section({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="space-y-3 border-[var(--ws-line)] border-b px-6 py-5 last:border-b-0">
      <div>
        <h2 className="m-0 font-semibold text-sm">{title}</h2>
        {description ? (
          <p className="m-0 text-[var(--ws-muted)] text-xs">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A person's face in the list: their own picture, or their initials. */
function MemberFace({ member }: { member: MemberView }) {
  const name = memberLabel(member);
  return member.imageUrl ? (
    <img
      alt=""
      className="h-8 w-8 shrink-0 rounded-full object-cover"
      height={32}
      src={member.imageUrl}
      width={32}
    />
  ) : (
    <Avatar color={AVATAR_COLOR} name={name} size="md" />
  );
}

function MemberRow({
  busy,
  canManage,
  member,
  onRemove,
  onRoleChange,
}: {
  busy: boolean;
  canManage: boolean;
  member: MemberView;
  onRemove: (member: MemberView) => void;
  onRoleChange: (member: MemberView, role: WorkspaceRole) => void;
}) {
  const roleId = useId();
  const name = memberLabel(member);

  const changeRole = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      onRoleChange(member, event.target.value as WorkspaceRole),
    [member, onRoleChange]
  );
  const remove = useCallback(() => onRemove(member), [member, onRemove]);

  return (
    <li className="flex items-center gap-3 border-[var(--ws-line)] border-b py-2.5 last:border-b-0">
      <MemberFace member={member} />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate font-medium text-sm">{name}</p>
        {member.email && member.email !== name ? (
          <p className="m-0 truncate text-[var(--ws-muted)] text-xs">
            {member.email}
          </p>
        ) : null}
      </div>

      {canManage ? (
        <>
          <label className="sr-only" htmlFor={roleId}>
            {`Role for ${name}`}
          </label>
          <select
            className="ws-focus rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2 py-1 text-sm"
            disabled={busy}
            id={roleId}
            onChange={changeRole}
            value={member.role}
          >
            {WORKSPACE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <Button
            aria-label={`Remove ${name}`}
            disabled={busy}
            onClick={remove}
            size="sm"
            variant="ghost"
          >
            Remove
          </Button>
        </>
      ) : (
        <span className="text-[var(--ws-muted)] text-xs">{member.role}</span>
      )}
    </li>
  );
}

/** Owner-only: look an email up at Clerk, then seat whoever it belongs to. */
function AddMember({ onAdded }: { onAdded: () => Promise<void> }) {
  const { api } = useActiveWorkspace();
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<MemberSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onEmailChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setEmail(event.target.value);
      setFound(null);
      setError(null);
    },
    []
  );

  const search = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = email.trim();
      if (!trimmed || busy) {
        return;
      }
      setBusy(true);
      (async () => {
        try {
          setFound(await api.searchMember(trimmed));
          setError(null);
        } catch (cause) {
          setError(messageOf(cause, "Could not look that email up."));
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, busy, email]
  );

  const add = useCallback(() => {
    if (!found?.exists) {
      return;
    }
    setBusy(true);
    (async () => {
      try {
        await api.addMember(found.email);
        await onAdded();
        setEmail("");
        setFound(null);
        setError(null);
      } catch (cause) {
        // 409 "already a member", 404 "no account for …" - the server's words.
        setError(messageOf(cause, "Could not add them."));
      } finally {
        setBusy(false);
      }
    })();
  }, [api, found, onAdded]);

  return (
    <div className="space-y-2">
      <form className="flex items-end gap-2" onSubmit={search}>
        <div className="flex-1">
          <TextField
            label="Add by email"
            onChange={onEmailChange}
            placeholder="person@example.com"
            type="email"
            value={email}
          />
        </div>
        <Button disabled={busy || email.trim() === ""} type="submit">
          Look up
        </Button>
      </form>

      {found && !found.exists ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          No account with that email. They have to sign up first.
        </p>
      ) : null}

      {found?.exists ? (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--ws-line)] px-3 py-2">
          <Avatar
            color={AVATAR_COLOR}
            name={found.name ?? found.email}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-sm">{found.name ?? found.email}</p>
            <p className="m-0 truncate text-[var(--ws-muted)] text-xs">
              {found.email}
            </p>
          </div>
          <Button disabled={busy} onClick={add} size="sm" variant="primary">
            Add
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}
    </div>
  );
}

/** Owner-only: the workspace's name. Its slug is fixed, so the URL never moves. */
function RenameWorkspace() {
  const { api, reload, workspace } = useActiveWorkspace();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(workspace ? workspace.name : "");
  }, [workspace]);

  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
      setSaved(false);
    },
    []
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed || busy) {
        return;
      }
      setBusy(true);
      (async () => {
        try {
          await api.renameWorkspace(trimmed);
          await reload();
          setError(null);
          setSaved(true);
        } catch (cause) {
          setError(messageOf(cause, "Could not rename the workspace."));
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, busy, name, reload]
  );

  return (
    <form className="flex items-end gap-2" onSubmit={submit}>
      <div className="flex-1">
        <TextField
          hint={saved ? "Saved." : undefined}
          label="Name"
          onChange={onNameChange}
          value={name}
        />
      </div>
      <Button disabled={busy || name.trim() === ""} type="submit">
        Rename
      </Button>
      {error ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}
    </form>
  );
}

/**
 * The one sentence that has to be in front of an owner before they touch the
 * key: every Anthropic-side resource is scoped to the key that made it, so
 * changing the key throws all of them away.
 */
const RESET_WARNING =
  "This resets the workspace's agents, connector credentials and skills on Anthropic's side. They re-register on the next sync.";

/** ", set 3 Mar 2026" - dropped entirely if the server sent nothing usable. */
const setOnNote = (setAt: string | null): string => {
  if (!setAt) {
    return "";
  }
  const at = Date.parse(setAt);
  return Number.isNaN(at) ? "" : `, set ${formatDay(at)}`;
};

/** Which key this workspace is spending, in one line. */
function AnthropicKeyState({ status }: { status: AnthropicKeyStatus | null }) {
  if (status === null) {
    return <p className="m-0 text-[var(--ws-muted)] text-xs">Checking…</p>;
  }
  if (!status.configured) {
    return (
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        Not configured — using the platform default key.
      </p>
    );
  }
  return (
    <p className="m-0 text-[var(--ws-muted)] text-xs">
      {`Using this workspace's own key …${status.hint ?? ""}${setOnNote(status.setAt)}`}
    </p>
  );
}

/**
 * Owner-only: the workspace's own Anthropic key. Write-only by design - the
 * server answers with the last four characters and never the key itself, so
 * nothing here holds the secret past the request that carries it away.
 */
function AnthropicKey() {
  const { api } = useActiveWorkspace();
  const [status, setStatus] = useState<AnthropicKeyStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [action, setAction] = useState<"remove" | "save">("save");

  const load = useCallback(async () => {
    try {
      setStatus(await api.getAnthropicKey());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Could not read the key's status."));
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const onKeyChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setApiKey(event.target.value);
    },
    []
  );

  const askSave = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (apiKey.trim() !== "") {
        setAction("save");
        setConfirming(true);
      }
    },
    [apiKey]
  );

  const askRemove = useCallback(() => {
    setAction("remove");
    setConfirming(true);
  }, []);

  const cancel = useCallback(() => setConfirming(false), []);

  const removing = action === "remove";

  // Whatever the server answers with is the new truth, so neither call needs a
  // re-read. A throw stays inside the dialog, which is where the owner is.
  const confirm = useCallback(async () => {
    setStatus(
      removing
        ? await api.removeAnthropicKey()
        : await api.setAnthropicKey(apiKey.trim())
    );
    setApiKey("");
    setError(null);
    setConfirming(false);
  }, [api, apiKey, removing]);

  return (
    <div className="space-y-3">
      <AnthropicKeyState status={status} />

      <form className="flex items-end gap-2" onSubmit={askSave}>
        <div className="flex-1">
          <TextField
            autoComplete="off"
            label={status?.configured ? "Replace with" : "Anthropic API key"}
            onChange={onKeyChange}
            placeholder="sk-ant-…"
            type="password"
            value={apiKey}
          />
        </div>
        <Button disabled={apiKey.trim() === ""} type="submit" variant="primary">
          Save
        </Button>
        {status?.configured ? (
          <Button onClick={askRemove} variant="danger">
            Remove
          </Button>
        ) : null}
      </form>

      {error ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}

      {/*
        Keyed by the action, which only ever changes while the dialog is shut:
        a rejected key's message must not still be on screen when the next
        thing you open is the Remove confirmation.
      */}
      <ConfirmDialog
        confirmLabel={removing ? "Remove key" : "Save key"}
        key={action}
        message={
          removing
            ? `Fall back to the platform default key? ${RESET_WARNING}`
            : `Use this key for every Anthropic call this workspace makes? ${RESET_WARNING}`
        }
        onCancel={cancel}
        onConfirm={confirm}
        open={confirming}
        title={removing ? "Remove Anthropic key" : "Set Anthropic key"}
      />
    </div>
  );
}

/** The label under a linked name, saying how the link was decided. */
const linkNote = (author: ExternalAuthorView): string => {
  if (!author.memberId) {
    return "Not linked to anyone yet";
  }
  return author.linkSource === "manual" ? "Linked by hand" : "Matched by email";
};

function ExternalAuthorRow({
  author,
  busy,
  canManage,
  members,
  onLink,
}: {
  author: ExternalAuthorView;
  busy: boolean;
  canManage: boolean;
  members: MemberView[];
  onLink: (author: ExternalAuthorView, memberId: string | null) => void;
}) {
  const selectId = useId();
  const change = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onLink(author, event.target.value || null),
    [author, onLink]
  );

  return (
    <li className="flex items-center gap-3 border-[var(--ws-line)] border-b py-2 last:border-b-0">
      <Avatar color={AVATAR_COLOR} name={author.displayName} size="md" />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm">{author.displayName}</p>
        <p className="m-0 truncate text-[var(--ws-muted)] text-xs">
          {linkNote(author)}
        </p>
      </div>
      {canManage ? (
        <>
          <label className="sr-only" htmlFor={selectId}>
            {`Who ${author.displayName} is`}
          </label>
          <select
            className="ws-focus rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2 py-1.5 text-[var(--ws-text)] text-xs"
            disabled={busy}
            id={selectId}
            onChange={change}
            value={author.memberId ?? ""}
          >
            <option value="">Nobody</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {memberLabel(member)}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </li>
  );
}

/**
 * Workspace settings: who is in it, what it is called, and how to end it. Only
 * an owner sees the controls; a member sees the same list, read-only.
 */
export function MembersSettings() {
  const { api, membership, slug, workspace } = useActiveWorkspace();
  const navigate = useNavigate();

  const [members, setMembers] = useState<MemberView[]>([]);
  const [externals, setExternals] = useState<ExternalAuthorView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isOwner = membership?.role === "owner";
  const title = workspace === null ? slug : workspace.name;

  const reload = useCallback(async () => {
    try {
      const [loadedMembers, loadedExternals] = await Promise.all([
        api.listMembers(),
        api.listExternalAuthors(),
      ]);
      setMembers(loadedMembers);
      setExternals(loadedExternals);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load members."));
    }
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = useCallback(
    (work: () => Promise<unknown>) => {
      setBusy(true);
      (async () => {
        try {
          await work();
          await reload();
          setError(null);
        } catch (cause) {
          // The last-owner guard answers 409 with a sentence worth showing.
          setError(messageOf(cause, "That did not work."));
        } finally {
          setBusy(false);
        }
      })();
    },
    [reload]
  );

  const changeRole = useCallback(
    (member: MemberView, role: WorkspaceRole) => {
      run(() => api.setMemberRole(member.id, role));
    },
    [api, run]
  );

  const removeMember = useCallback(
    (member: MemberView) => {
      run(() => api.removeMember(member.id));
    },
    [api, run]
  );

  const linkAuthor = useCallback(
    (author: ExternalAuthorView, memberId: string | null) => {
      run(() => api.linkExternalAuthor(author.authorId, memberId));
    },
    [api, run]
  );

  const askDelete = useCallback(() => setDeleteOpen(true), []);
  const cancelDelete = useCallback(() => setDeleteOpen(false), []);
  const confirmDelete = useCallback(async () => {
    await api.deleteWorkspace();
    setDeleteOpen(false);
    await navigate({ to: "/" });
  }, [api, navigate]);

  return (
    <div className="ws-shell justify-center overflow-y-auto">
      <div className="w-full max-w-2xl">
        <header className="flex items-center justify-between gap-3 border-[var(--ws-line)] border-b px-6 py-4">
          <div className="min-w-0">
            <h1 className="m-0 truncate font-semibold text-lg">{title}</h1>
            <p className="m-0 text-[var(--ws-muted)] text-xs">
              Workspace settings
            </p>
          </div>
          <Link
            className="text-[var(--ws-accent)] text-sm no-underline"
            params={{ workspaceSlug: slug }}
            search={{}}
            to="/w/$workspaceSlug"
          >
            ← Back
          </Link>
        </header>

        <Section
          description={
            isOwner
              ? "Anyone here can talk to every agent in this workspace."
              : "Only an owner can change who is in this workspace."
          }
          title="Members"
        >
          {isOwner ? <AddMember onAdded={reload} /> : null}

          <ul className="m-0 list-none p-0">
            {members.map((member) => (
              <MemberRow
                busy={busy}
                canManage={isOwner === true}
                key={member.id}
                member={member}
                onRemove={removeMember}
                onRoleChange={changeRole}
              />
            ))}
          </ul>

          {error ? (
            <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
          ) : null}
        </Section>

        {externals.length > 0 ? (
          <Section
            description={
              isOwner
                ? "People who write in from Slack. Saying who somebody is renames every message they have ever sent here, not just the next one."
                : "People who write in from Slack. Only an owner can change who they are."
            }
            title="From Slack"
          >
            <ul className="m-0 list-none p-0">
              {externals.map((author) => (
                <ExternalAuthorRow
                  author={author}
                  busy={busy}
                  canManage={isOwner === true}
                  key={author.authorId}
                  members={members}
                  onLink={linkAuthor}
                />
              ))}
            </ul>
          </Section>
        ) : null}

        {isOwner ? (
          <Section title="Name">
            <RenameWorkspace />
          </Section>
        ) : null}

        {isOwner ? (
          <Section
            description="Optional. Without one, this workspace runs on the platform's default key. Setting, rotating or removing a key resets this workspace's agents, connector credentials and skills on Anthropic's side; they re-register on the next sync."
            title="Anthropic API key"
          >
            <AnthropicKey />
          </Section>
        ) : null}

        {isOwner ? (
          <Section
            description="Deletes its channels, agents, skills, connectors and wiki. There is no undo."
            title="Delete workspace"
          >
            <Button onClick={askDelete} variant="danger">
              Delete this workspace
            </Button>
          </Section>
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel="Delete workspace"
        message={`Delete ${title} and everything in it?`}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
        open={deleteOpen}
        title="Delete workspace"
      />
    </div>
  );
}
