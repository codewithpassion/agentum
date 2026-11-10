import type { AgentTemplateId, ProfileGap, VoicePreset } from "@repo/db/shared";
import type {
  AgentDraft,
  BuilderCatalog,
} from "@repo/services/agent-builder/draft";
import { templates } from "@repo/services/agent-builder/templates";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useState } from "react";
import {
  addressSuggestion,
  applyEdit,
  builderSteps,
  clearDescription,
  type Locked,
  loadDescription,
  openGaps,
  redraftBlocker,
  saveDescription,
} from "#/components/agent/builder/builder-logic.ts";
import { DescribePanel } from "#/components/agent/builder/describe-panel";
import { DraftCard } from "#/components/agent/builder/draft-card";
import {
  cleanSample,
  createBlocker,
  draftSaveKey,
  dryRunRuntime,
  type SampleChip,
  serverDraft,
} from "#/components/agent/builder/dry-run-logic.ts";
import {
  DryRunPanel,
  type DryRunStep,
} from "#/components/agent/builder/dry-run-panel";
import { StartBlank } from "#/components/agent/builder/start-blank";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/agents/new")({
  loader: async () => {
    try {
      return { catalog: await getTrpc().agentBuilder.catalog.query() };
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      throw error;
    }
  },
  component: NewAgent,
});

interface Drafted {
  didList: string[];
  draft: AgentDraft;
  gaps: ProfileGap[];
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Start blank: saves the draft and activates it, with no builder call. */
function BlankAgent({ catalog }: { catalog: BuilderCatalog }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | undefined>();
  const router = useRouter();
  const navigate = useNavigate();
  const create = useCallback(
    async (draft: AgentDraft) => {
      setBusy(true);
      setError(null);
      try {
        const trpc = getTrpc();
        // A failed create leaves its draft row, so a retry saves over it.
        const saved = await trpc.agentBuilder.saveDraft.mutate({
          draft,
          ...(draftId === undefined ? {} : { draftAgentId: draftId }),
        });
        setDraftId(saved.id);
        const created = await trpc.agentBuilder.create.mutate({
          draft,
          draftAgentId: saved.id,
        });
        await router.invalidate();
        await navigate({
          params: { agentId: created.id },
          to: "/agents/$agentId",
        });
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [draftId, navigate, router]
  );
  return (
    <StartBlank busy={busy} catalog={catalog} error={error} onCreate={create} />
  );
}

function DescribeAgent({ catalog }: { catalog: BuilderCatalog }) {
  const [description, setDescription] = useState("");
  // Storage is read after mount, so the first render matches the server.
  const [restored, setRestored] = useState(false);
  const [voice, setVoice] = useState<VoicePreset | undefined>();
  const [templateId, setTemplateId] = useState<AgentTemplateId | undefined>();
  const [drafted, setDrafted] = useState<Drafted | undefined>();
  const [locked, setLocked] = useState<Locked>({});
  const [addressEdit, setAddressEdit] = useState<string | undefined>();
  const [descriptionDictating, setDescriptionDictating] = useState(false);
  const [draftDictating, setDraftDictating] = useState(false);
  const dictating = descriptionDictating || draftDictating;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftAgentId, setDraftAgentId] = useState<string | undefined>();
  const [savedKey, setSavedKey] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | null>(null);
  const [pending, setPending] = useState<DryRunStep | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const router = useRouter();
  const navigate = useNavigate();

  useEffect(() => {
    setDescription(loadDescription(window.sessionStorage));
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored) {
      saveDescription(window.sessionStorage, description);
    }
  }, [restored, description]);

  const draft = drafted?.draft;
  const address =
    addressEdit ?? (draft === undefined ? "" : addressSuggestion(draft.name));

  const pickTemplate = useCallback((id: AgentTemplateId) => {
    setDescription(templates[id].description);
    setVoice(templates[id].voice);
    setTemplateId(id);
  }, []);

  const edit = useCallback(
    (patch: Partial<AgentDraft>) => {
      if (drafted === undefined) {
        return;
      }
      const next = applyEdit(drafted.draft, locked, patch);
      setDrafted({ ...drafted, draft: next.draft });
      setLocked(next.locked);
    },
    [drafted, locked]
  );

  const pickVoice = useCallback(
    (next: VoicePreset) => {
      setVoice(next);
      edit({ voice: next });
    },
    [edit]
  );

  const runDraft = useCallback(async () => {
    if (dictating || busy || pending !== null) {
      return;
    }
    const blocker = draft === undefined ? null : redraftBlocker(draft);
    setError(blocker);
    if (blocker !== null) {
      return;
    }
    setBusy(true);
    try {
      const voicePreset = draft?.voice ?? voice;
      setDrafted(
        await getTrpc().agentBuilder.draft.mutate({
          description,
          ...(draft === undefined ? {} : { locked, previous: draft }),
          ...(templateId === undefined ? {} : { templateId }),
          ...(voicePreset === undefined ? {} : { voicePreset }),
        })
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [description, draft, locked, templateId, voice, dictating, busy, pending]);

  const dryRun = dryRunRuntime(catalog, draft?.runsOn ?? null);

  const gaps =
    drafted === undefined ? [] : openGaps(drafted.gaps, drafted.draft, locked);

  const editSample = useCallback(
    (sampleInput: SampleChip[]) => edit({ sampleInput }),
    [edit]
  );

  /** The draft's row id, saving the draft first when it is new or has changed since the last save. */
  const ensureSaved = useCallback(
    async (current: AgentDraft): Promise<string> => {
      const sendable = serverDraft(current);
      const key = draftSaveKey(sendable);
      if (draftAgentId !== undefined && savedKey === key) {
        return draftAgentId;
      }
      const saved = await getTrpc().agentBuilder.saveDraft.mutate({
        draft: sendable,
        ...(draftAgentId === undefined ? {} : { draftAgentId }),
      });
      setDraftAgentId(saved.id);
      setSavedKey(key);
      return saved.id;
    },
    [draftAgentId, savedKey]
  );

  /** Runs `action` as the panel's pending step and shows what fails. */
  const act = useCallback(
    async (step: DryRunStep, action: () => Promise<void>) => {
      setPending(step);
      setPanelError(null);
      try {
        await action();
      } catch (cause) {
        setPanelError(messageOf(cause));
      } finally {
        setPending(null);
      }
    },
    []
  );

  const runDry = useCallback(async () => {
    if (draft === undefined || dictating || busy || pending !== null) {
      return;
    }
    await act("run", async () => {
      const id = await ensureSaved(draft);
      const started = await getTrpc().agentBuilder.dryRun.mutate({
        draftAgentId: id,
        sample: cleanSample(draft.sampleInput),
      });
      setRunId(started.runId);
    });
  }, [act, draft, ensureSaved, dictating, busy, pending]);

  const createAgent = useCallback(async () => {
    if (draft === undefined || dictating || busy || pending !== null) {
      return;
    }
    await act("create", async () => {
      const trpc = getTrpc();
      // A taken address would fail after the agent is active, so ask first.
      if (address !== "") {
        const { available } = await trpc.agents.checkAddress.query({
          local: address,
        });
        if (!available) {
          throw new Error(`The address ${address} is taken. Pick another.`);
        }
      }
      const id = await ensureSaved(draft);
      const created = await trpc.agentBuilder.create.mutate({
        ...(address === "" ? {} : { address }),
        draft: serverDraft(draft),
        draftAgentId: id,
      });
      clearDescription(window.sessionStorage);
      await router.invalidate();
      await navigate({
        params: { agentId: created.id },
        to: "/agents/$agentId",
      });
    });
  }, [
    act,
    address,
    draft,
    ensureSaved,
    navigate,
    router,
    dictating,
    busy,
    pending,
  ]);

  const discardDraft = useCallback(
    () =>
      act("discard", async () => {
        if (draftAgentId !== undefined) {
          await getTrpc().agentBuilder.discard.mutate({ draftAgentId });
        }
        clearDescription(window.sessionStorage);
        await navigate({ to: "/agents" });
      }),
    [act, draftAgentId, navigate]
  );

  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3.5">
        <DescribePanel
          busy={busy || draftDictating || pending !== null}
          description={description}
          error={error}
          hasDraft={draft !== undefined}
          onDescription={setDescription}
          onDictationBusyChange={setDescriptionDictating}
          onDraft={runDraft}
          onTemplate={pickTemplate}
          onVoice={pickVoice}
          steps={
            drafted === undefined ? [] : builderSteps(drafted.didList, gaps)
          }
          voice={draft?.voice ?? voice}
        />
      </div>
      <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-3.5">
        {draft === undefined ? (
          <p className="rounded-lg border border-border border-dashed p-6 text-muted-foreground text-sm">
            Describe the agent and press Draft. The draft shows here, and every
            part of it stays editable.
          </p>
        ) : (
          <DraftCard
            address={address}
            catalog={catalog}
            disabled={busy || descriptionDictating || pending !== null}
            draft={draft}
            gaps={gaps}
            locked={locked}
            onAddress={setAddressEdit}
            onDictationBusyChange={setDraftDictating}
            onEdit={edit}
          />
        )}
        {draft === undefined ? null : (
          <DryRunPanel
            createBlocker={
              dictating ? "Finish dictation first." : createBlocker(gaps)
            }
            error={panelError}
            onCreate={createAgent}
            onDiscard={discardDraft}
            onRun={runDry}
            onSample={editSample}
            pending={pending}
            runBlocker={
              dictating
                ? "Finish dictation first."
                : (redraftBlocker(draft) ?? dryRun.blocker)
            }
            runId={runId}
            runtimeNote={dryRun.note}
            sample={draft.sampleInput}
          />
        )}
      </div>
    </div>
  );
}

function NewAgent() {
  const { catalog } = Route.useLoaderData();
  const [blank, setBlank] = useState(false);
  const showBlank = useCallback(() => setBlank(true), []);
  const showDescribe = useCallback(() => setBlank(false), []);
  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="text-muted-foreground text-sm">
        <Link
          className="pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center hover:text-foreground"
          to="/agents"
        >
          Agents
        </Link>
        {" › New agent"}
      </div>
      <h1 className="font-heading text-3xl text-foreground">New agent</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-pressed={!blank}
          onClick={showDescribe}
          type="button"
          variant={blank ? "outline" : "secondary"}
        >
          Describe it
        </Button>
        <Button
          aria-pressed={blank}
          onClick={showBlank}
          type="button"
          variant={blank ? "secondary" : "outline"}
        >
          Start blank
        </Button>
      </div>
      {blank ? <BlankAgent catalog={catalog} /> : null}
      {/* Hidden, not unmounted, so a draft survives a look at Start blank. */}
      <div hidden={blank}>
        <DescribeAgent catalog={catalog} />
      </div>
    </section>
  );
}
