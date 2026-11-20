import type { JobSentence, ProposedTrigger } from "@repo/db/shared";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RoutinesPanel } from "#/components/agent/profile/sheets/routines.tsx";
import { TriggersPanel } from "#/components/agent/profile/sheets/triggers.tsx";
import { CreateRoutineDialog } from "#/components/routines/create-routine-dialog.tsx";
import type { CreatedTrigger } from "#/components/triggers/create-trigger-dialog.tsx";
import { TriggerSecretDialog } from "#/components/triggers/trigger-secret-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { getTrpc } from "#/integrations/trpc/client.ts";
import type { AgentRecord } from "#/integrations/trpc/types.ts";
import { errorMessage } from "#/lib/error-message.ts";
import { DescribeJob } from "./describe-job.tsx";
import { DraftReview } from "./draft-review.tsx";
import { draftName, draftRoutineInput, draftSaveKind } from "./job-logic.ts";
import { JobRow } from "./job-row.tsx";

interface PendingDraft {
  agentId: string;
  draft: ProposedTrigger;
}

interface SecretShown extends CreatedTrigger {
  title: string;
}

/**
 * Jobs as sentences with pause, edit, run now and a box to describe a new
 * one. With `fixedAgentId` it lists that agent's jobs, without it every
 * agent's.
 */
export function JobsPanel({
  agents,
  fixedAgentId,
  onOpenKeys,
  readOnly = false,
}: {
  agents: readonly AgentRecord[];
  /** The agent whose jobs this lists. Leave out to list the whole workspace. */
  fixedAgentId?: string;
  /** Mail and Slack starts are set up under Keys. */
  onOpenKeys: (agentId: string) => void;
  readOnly?: boolean;
}) {
  const [jobs, setJobs] = useState<JobSentence[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState<JobSentence | null>(null);
  const [secret, setSecret] = useState<SecretShown | null>(null);

  const load = useCallback(async () => {
    try {
      const trpc = getTrpc();
      setJobs(
        fixedAgentId === undefined
          ? await trpc.jobs.list.query()
          : await trpc.jobs.forAgent.query({ agentId: fixedAgentId })
      );
      setNowMs(Date.now());
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [fixedAgentId]);

  useEffect(() => {
    load();
  }, [load]);

  const pause = useCallback(
    async (job: JobSentence) => {
      const enabled = !job.enabled;
      setBusyId(job.id);
      setError(undefined);
      try {
        const trpc = getTrpc();
        if (job.source === "routine") {
          await trpc.routines.setEnabled.mutate({
            enabled,
            routineId: job.id,
          });
        } else {
          const result = await trpc.triggers.setEnabled.mutate({
            enabled,
            triggerId: job.id,
          });
          // Resuming a proposed web trigger approves it, and the secret is shown once.
          if (result.secret !== null) {
            setSecret({
              secret: result.secret,
              title: "Trigger approved",
              trigger: result.trigger,
            });
          }
        }
      } catch (cause) {
        setError(errorMessage(cause));
      }
      setBusyId(null);
      await load();
    },
    [load]
  );

  const runNow = useCallback(
    async (job: JobSentence) => {
      setBusyId(job.id);
      setError(undefined);
      try {
        await getTrpc().jobs.runNow.mutate({ jobId: job.id });
        toast.success("Started. Follow it under Work.");
      } catch (cause) {
        setError(errorMessage(cause));
      }
      setBusyId(null);
      await load();
    },
    [load]
  );

  const edit = useCallback(
    (job: JobSentence) => {
      if (job.source === "mail" || job.source === "slack") {
        onOpenKeys(job.agent.id);
        return;
      }
      setEditing(job);
    },
    [onOpenKeys]
  );

  const closeEdit = useCallback(() => {
    setEditing(null);
    load();
  }, [load]);

  const handleEditOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeEdit();
      }
    },
    [closeEdit]
  );

  const describe = useCallback(async (agentId: string, text: string) => {
    setDrafting(true);
    setDraftError(null);
    setSaveError(null);
    try {
      const draft = await getTrpc().jobs.draft.mutate({ agentId, text });
      setPending({ agentId, draft });
    } catch (cause) {
      setPending(null);
      setDraftError(errorMessage(cause));
    }
    setDrafting(false);
  }, []);

  const discard = useCallback(() => {
    setPending(null);
    setSaveError(null);
  }, []);

  const save = useCallback(async () => {
    if (pending === null) {
      return;
    }
    const kind = draftSaveKind(pending.draft);
    setSaving(true);
    setSaveError(null);
    try {
      const trpc = getTrpc();
      if (kind === "routine") {
        await trpc.routines.create.mutate(
          draftRoutineInput(pending.agentId, pending.draft)
        );
      } else if (kind === "http") {
        const created = await trpc.triggers.create.mutate({
          agentId: pending.agentId,
          name: draftName(pending.draft.does),
        });
        if (created.secret === null) {
          throw new Error("The trigger was created without a secret.");
        }
        setSecret({
          secret: created.secret,
          title: "Trigger created",
          trigger: created.trigger,
        });
      } else {
        throw new Error("This kind of job cannot be saved here.");
      }
      setPending(null);
      await load();
    } catch (cause) {
      setSaveError(errorMessage(cause));
    }
    setSaving(false);
  }, [load, pending]);

  const openReview = useCallback(() => setReviewing(true), []);
  const closeReview = useCallback(() => setReviewing(false), []);
  const reviewed = useCallback(() => {
    setReviewing(false);
    setPending(null);
    load();
  }, [load]);

  const openKeysForDraft = useCallback(() => {
    if (pending !== null) {
      onOpenKeys(pending.agentId);
    }
  }, [onOpenKeys, pending]);

  const closeSecret = useCallback(() => {
    setSecret(null);
    load();
  }, [load]);

  const agentName = (id: string): string | undefined =>
    agents.find((agent) => agent.id === id)?.name;
  const editingAgent =
    editing === null
      ? undefined
      : agents.find((agent) => agent.id === editing.agent.id);

  let body: ReactNode = (
    <p className="text-muted-foreground text-sm">Loading jobs.</p>
  );
  if (jobs !== undefined) {
    body =
      jobs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No jobs yet. Describe one above.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {jobs.map((job) => (
            <JobRow
              busy={busyId === job.id}
              job={job}
              key={job.id}
              nowMs={nowMs}
              onEdit={edit}
              onPause={pause}
              onRunNow={runNow}
              readOnly={readOnly}
              showAgent={fixedAgentId === undefined}
            />
          ))}
        </ul>
      );
  }

  return (
    <section className="flex min-w-0 flex-col gap-4">
      {readOnly ? null : (
        <DescribeJob
          agentId={fixedAgentId}
          agents={agents}
          busy={drafting}
          error={draftError}
          onSubmit={describe}
        />
      )}
      {pending === null ? null : (
        <DraftReview
          agentName={
            fixedAgentId === undefined ? agentName(pending.agentId) : undefined
          }
          draft={pending.draft}
          error={saveError}
          onDiscard={discard}
          onEdit={openReview}
          onOpenKeys={openKeysForDraft}
          onSave={save}
          saving={saving}
        />
      )}
      {error === undefined ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      {body}
      {editing === null || editingAgent === undefined ? null : (
        <Dialog onOpenChange={handleEditOpenChange} open>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Edit job</DialogTitle>
              <DialogDescription>
                {editing.source === "routine"
                  ? `The routines of ${editingAgent.name}. Pause, remove or create one here.`
                  : `The web triggers of ${editingAgent.name}. Pause, revoke or create one here.`}
              </DialogDescription>
            </DialogHeader>
            {editing.source === "routine" ? (
              <RoutinesPanel agent={editingAgent} />
            ) : (
              <TriggersPanel agent={editingAgent} />
            )}
          </DialogContent>
        </Dialog>
      )}
      {reviewing && pending !== null ? (
        <CreateRoutineDialog
          agentId={pending.agentId}
          initial={{
            cron: pending.draft.cron ?? "",
            name: draftName(pending.draft.does),
            prompt: pending.draft.does,
            timezone: pending.draft.timezone ?? "",
          }}
          onClose={closeReview}
          onCreated={reviewed}
        />
      ) : null}
      {secret === null ? null : (
        <TriggerSecretDialog
          onDone={closeSecret}
          secret={secret.secret}
          title={secret.title}
          triggerId={secret.trigger.id}
        />
      )}
    </section>
  );
}
