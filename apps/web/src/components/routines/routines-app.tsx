import { useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import type { Routine } from "#/lib/api";
import { cx } from "#/lib/cx";
import { useRoutineDetail, useRoutines } from "#/lib/use-routines";
import { useWorkspaceData } from "#/lib/use-workspace-data";
import { useApi, useWorkspaceSlug } from "#/lib/workspace-context";
import { RoutineDetail } from "./routine-detail";
import { RoutineForm } from "./routine-form";
import { type RoutineActions, RoutineList } from "./routine-list";
import { RunStatusDot } from "./routine-status";

/**
 * The routines section: the list and one routine's history side by side - the
 * same shape as skills and connectors, which is the app's "top-level section"
 * layout. Writing and editing a routine are modes of the route rather than
 * dialogs, because a schedule picker with a live preview does not fit in one.
 */

const rowClass = (active: boolean): string =>
  cx(
    "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] no-underline",
    active
      ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
      : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
  );

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "That did not work.";

function SignedOutNotice() {
  return (
    <div className="ws-shell items-center justify-center">
      <p className="m-0 text-[var(--ws-muted)] text-sm">
        <a className="text-[var(--ws-accent)]" href="/login">
          Sign in
        </a>{" "}
        to manage routines.
      </p>
    </div>
  );
}

export function RoutinesApp({
  creating = false,
  editing = false,
  routineId,
}: {
  creating?: boolean;
  editing?: boolean;
  routineId: string | null;
}) {
  const api = useApi();
  const workspaceSlug = useWorkspaceSlug();

  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const navigate = useNavigate();

  const { error: listError, reload, routines } = useRoutines(signedIn);
  const {
    error: detailError,
    loadMore,
    reload: reloadDetail,
    routine,
    runs,
  } = useRoutineDetail(routineId, signedIn);
  const { agents, channels } = useWorkspaceData(signedIn);

  /** The routine a mutation is in flight for, and what went wrong last. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);

  const refreshAll = useCallback(async () => {
    await reload();
    await reloadDetail();
  }, [reload, reloadDetail]);

  const startNew = useCallback(() => {
    navigate({
      params: { workspaceSlug },
      search: { new: true },
      to: "/w/$workspaceSlug/routines",
    });
  }, [navigate, workspaceSlug]);

  const cancelNew = useCallback(() => {
    navigate({
      params: { workspaceSlug },
      search: {},
      to: "/w/$workspaceSlug/routines",
    });
  }, [navigate, workspaceSlug]);

  const startEdit = useCallback(() => {
    if (routineId) {
      navigate({
        params: { routineId, workspaceSlug },
        search: { edit: true },
        to: "/w/$workspaceSlug/routines/$routineId",
      });
    }
  }, [navigate, routineId, workspaceSlug]);

  const stopEdit = useCallback(() => {
    if (routineId) {
      navigate({
        params: { routineId, workspaceSlug },
        search: {},
        to: "/w/$workspaceSlug/routines/$routineId",
      });
    }
  }, [navigate, routineId, workspaceSlug]);

  const onCreated = useCallback(
    async (created: Routine) => {
      await reload();
      await navigate({
        params: { routineId: created.id, workspaceSlug },
        search: {},
        to: "/w/$workspaceSlug/routines/$routineId",
      });
    },
    [navigate, reload, workspaceSlug]
  );

  const onSaved = useCallback(
    async (saved: Routine) => {
      await refreshAll();
      await navigate({
        params: { routineId: saved.id, workspaceSlug },
        search: {},
        to: "/w/$workspaceSlug/routines/$routineId",
      });
    },
    [navigate, refreshAll, workspaceSlug]
  );

  /** Every row action runs the same way: mark busy, act, refetch, or report. */
  const act = useCallback(
    async (target: Routine, action: (id: string) => Promise<unknown>) => {
      setBusyId(target.id);
      setActionError(null);
      try {
        await action(target.id);
        await refreshAll();
      } catch (cause) {
        setActionError(messageOf(cause));
      } finally {
        setBusyId(null);
      }
    },
    [refreshAll]
  );

  const onToggle = useCallback(
    (target: Routine) => {
      act(target, (id) => api.updateRoutine(id, { enabled: !target.enabled }));
    },
    [act, api]
  );

  const onRunNow = useCallback(
    (target: Routine) => {
      act(target, (id) => api.runRoutine(id));
    },
    [act, api]
  );

  const cancelDelete = useCallback(() => setDeleting(null), []);

  const confirmDelete = useCallback(async () => {
    if (!deleting) {
      return;
    }
    const target = deleting;
    setDeleting(null);
    setActionError(null);
    try {
      await api.deleteRoutine(target.id);
    } catch (cause) {
      setActionError(messageOf(cause));
    }
    await reload();
    if (routineId === target.id) {
      await navigate({
        params: { workspaceSlug },
        search: {},
        to: "/w/$workspaceSlug/routines",
      });
    }
  }, [api, deleting, navigate, reload, routineId, workspaceSlug]);

  const actions: RoutineActions = {
    onDelete: setDeleting,
    onNew: startNew,
    onRunNow,
    onToggle,
  };

  if (isSignedIn === false) {
    return <SignedOutNotice />;
  }

  const error = actionError ?? listError ?? detailError;
  const showForm = creating || (editing && routine);

  return (
    <div className="ws-shell">
      <nav
        aria-label="Routines"
        className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <Link
            className="font-semibold text-sm no-underline"
            params={{ workspaceSlug }}
            to="/w/$workspaceSlug"
          >
            ← Agentum
          </Link>
          <Button
            aria-label="New routine"
            onClick={startNew}
            size="icon"
            title="New routine"
            variant="ghost"
          >
            <span aria-hidden="true">＋</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          <h2 className="px-2 pt-1 pb-2 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
            Routines
          </h2>
          {routines.length === 0 ? (
            <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
              No routines yet.
            </p>
          ) : null}
          {routines.map((row) => (
            <Link
              className={rowClass(row.id === routineId)}
              key={row.id}
              params={{ routineId: row.id, workspaceSlug }}
              search={{}}
              to="/w/$workspaceSlug/routines/$routineId"
            >
              {row.lastRun ? (
                <RunStatusDot run={row.lastRun} />
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ws-line)]"
                />
              )}
              <span className="truncate">{row.name}</span>
              {row.enabled ? null : (
                <span className="shrink-0 text-[var(--ws-muted)] text-xs">
                  paused
                </span>
              )}
            </Link>
          ))}
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showForm ? (
          <RoutineForm
            agents={agents}
            channels={channels}
            onCancel={creating ? cancelNew : stopEdit}
            onSaved={creating ? onCreated : onSaved}
            routine={creating ? null : routine}
          />
        ) : null}

        {!showForm && routine ? (
          <RoutineDetail
            busy={busyId === routine.id}
            loadMore={loadMore}
            onDelete={setDeleting}
            onEdit={startEdit}
            onRunNow={onRunNow}
            onToggle={onToggle}
            routine={routine}
            runs={runs}
          />
        ) : null}

        {showForm || routineId ? null : (
          <RoutineList actions={actions} busyId={busyId} routines={routines} />
        )}
      </main>

      {error ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-danger)] text-xs">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        confirmLabel="Delete routine"
        message={`Delete ${deleting?.name ?? ""}? Its past runs and the messages they posted stay; the schedule is gone.`}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
        open={deleting !== null}
        title="Delete routine"
      />
    </div>
  );
}
