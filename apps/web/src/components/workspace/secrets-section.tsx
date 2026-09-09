import { useUser } from "@clerk/tanstack-react-start";
import { useCallback, useState } from "react";
import { SkillSyncDot } from "#/components/skills/skill-status";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import type { Secret } from "#/lib/api";
import {
  hintLabel,
  hostsLabel,
  lastUsedLabel,
  SECRET_SYNC_LABELS,
  secretDotStatus,
  secretSummary,
} from "#/lib/secrets-format";
import { useSecrets } from "#/lib/use-secrets";
import { useActiveWorkspace } from "#/lib/workspace-context";
import { ConfirmDialog } from "./confirm-dialog";
import { SecretDialog, type SecretDialogMode } from "./secret-dialog";
import { MENU_ITEM_CLASS } from "./sidebar-menu";
import { SectionHint, SidebarSection } from "./sidebar-section";

/**
 * The workspace's secrets in the sidebar, next to Connectors and Skills: what
 * is stored, where each one may be sent, and when it was last spent. There is
 * no detail page and there is nothing to open one for - a secret is a name, an
 * allowlist and four characters of hint, and that is the whole of it.
 *
 * Adding, rotating and deleting are owner-only, as the API is; a member sees
 * the list, because knowing what an agent can reach is a member's business.
 */

export const SECRETS_SECTION = "secrets";

const rowClass =
  "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-[var(--ws-muted)]";

function SecretMenu({
  onDelete,
  onOpen,
  secret,
}: {
  onDelete: (secret: Secret) => void;
  onOpen: (mode: SecretDialogMode, secret: Secret) => void;
  secret: Secret;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((previous) => !previous), []);
  const close = useCallback(() => setOpen(false), []);

  const edit = useCallback(() => {
    setOpen(false);
    onOpen("edit", secret);
  }, [onOpen, secret]);

  const rotate = useCallback(() => {
    setOpen(false);
    onOpen("rotate", secret);
  }, [onOpen, secret]);

  const remove = useCallback(() => {
    setOpen(false);
    onDelete(secret);
  }, [onDelete, secret]);

  return (
    <div className="relative">
      <Button
        aria-label={`Manage ${secret.name}`}
        onClick={toggle}
        size="icon"
        title={`Manage ${secret.name}`}
        variant="ghost"
      >
        <span aria-hidden="true">⋯</span>
      </Button>
      <Popover align="right" onClose={close} open={open}>
        <button className={MENU_ITEM_CLASS} onClick={edit} type="button">
          Edit hosts and header…
        </button>
        <button className={MENU_ITEM_CLASS} onClick={rotate} type="button">
          Rotate value…
        </button>
        <button className={MENU_ITEM_CLASS} onClick={remove} type="button">
          Delete…
        </button>
      </Popover>
    </div>
  );
}

function SecretRow({
  canManage,
  onDelete,
  onOpen,
  secret,
}: {
  canManage: boolean;
  onDelete: (secret: Secret) => void;
  onOpen: (mode: SecretDialogMode, secret: Secret) => void;
  secret: Secret;
}) {
  return (
    <div
      className={rowClass}
      data-testid="sidebar-secret"
      title={`${secretSummary(secret)} · ${secret.syncError ?? SECRET_SYNC_LABELS[secret.syncStatus]}`}
    >
      <span className="pt-1.5">
        <SkillSyncDot status={secretDotStatus(secret.syncStatus)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[var(--ws-text)]">
          {secret.name} <span>{hintLabel(secret.hint)}</span>
        </span>
        <span className="block truncate text-[10px]">
          {hostsLabel(secret.allowedHosts)} · {lastUsedLabel(secret.lastUsedAt)}
        </span>
      </span>
      {canManage ? (
        <SecretMenu onDelete={onDelete} onOpen={onOpen} secret={secret} />
      ) : null}
    </div>
  );
}

export function SecretsSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (sectionKey: string) => void;
}) {
  const { api, membership } = useActiveWorkspace();
  const { isSignedIn } = useUser();
  const { error, reload, secrets } = useSecrets(isSignedIn === true);

  // One dialog for all three of add, edit and rotate: which fields it shows is
  // the mode's business, not this section's.
  const [dialog, setDialog] = useState<{
    mode: SecretDialogMode;
    secret: Secret | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<Secret | null>(null);

  const canManage = membership?.role === "owner";

  const openAdd = useCallback(
    () => setDialog({ mode: "add", secret: null }),
    []
  );
  const openFor = useCallback(
    (mode: SecretDialogMode, secret: Secret) => setDialog({ mode, secret }),
    []
  );
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeDelete = useCallback(() => setDeleting(null), []);

  const confirmDelete = useCallback(async () => {
    if (!deleting) {
      return;
    }
    await api.deleteSecret(deleting.id);
    setDeleting(null);
    await reload();
  }, [api, deleting, reload]);

  return (
    <>
      <SidebarSection
        actions={
          canManage ? (
            <Button
              aria-label="Add secret"
              onClick={openAdd}
              size="icon"
              title="Add secret"
              variant="ghost"
            >
              <span aria-hidden="true">＋</span>
            </Button>
          ) : undefined
        }
        expanded={expanded}
        label="Secrets"
        onToggle={onToggle}
        sectionKey={SECRETS_SECTION}
      >
        {secrets.length === 0 ? (
          <SectionHint>No secrets yet.</SectionHint>
        ) : (
          secrets.map((secret) => (
            <SecretRow
              canManage={canManage === true}
              key={secret.id}
              onDelete={setDeleting}
              onOpen={openFor}
              secret={secret}
            />
          ))
        )}
        {error ? (
          <p className="m-0 px-2 py-1 text-[var(--ws-danger)] text-xs">
            {error}
          </p>
        ) : null}
      </SidebarSection>

      <SecretDialog
        mode={dialog?.mode ?? "add"}
        onClose={closeDialog}
        onSaved={reload}
        open={dialog !== null}
        secret={dialog?.secret ?? null}
      />

      <ConfirmDialog
        confirmLabel="Delete"
        message={
          deleting
            ? `Delete ${deleting.name}? The agents that hold it lose it at once, and the value cannot be recovered - you would have to paste a new one.`
            : ""
        }
        onCancel={closeDelete}
        onConfirm={confirmDelete}
        open={deleting !== null}
        title="Delete this secret?"
      />
    </>
  );
}
