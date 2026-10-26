import type { AgentTemplateId, ProfileGap, VoicePreset } from "@repo/db/shared";
import type { AgentDraft } from "@repo/services/agent-builder/draft";
import { templates } from "@repo/services/agent-builder/templates";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import {
  addressSuggestion,
  applyEdit,
  builderSteps,
  type Locked,
  openGaps,
  redraftBlocker,
} from "#/components/agent/builder/builder-logic.ts";
import { DescribePanel } from "#/components/agent/builder/describe-panel";
import { DraftCard } from "#/components/agent/builder/draft-card";
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

function NewAgent() {
  const { catalog } = Route.useLoaderData();
  const [description, setDescription] = useState("");
  const [voice, setVoice] = useState<VoicePreset | undefined>();
  const [templateId, setTemplateId] = useState<AgentTemplateId | undefined>();
  const [drafted, setDrafted] = useState<Drafted | undefined>();
  const [locked, setLocked] = useState<Locked>({});
  const [addressEdit, setAddressEdit] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [description, draft, locked, templateId, voice]);

  const gaps =
    drafted === undefined ? [] : openGaps(drafted.gaps, drafted.draft, locked);

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="text-muted-foreground text-sm">
        <Link className="hover:text-foreground" to="/agents">
          Agents
        </Link>
        {" › New agent"}
      </div>
      <h1 className="font-heading text-3xl text-foreground">New agent</h1>
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3.5">
          <DescribePanel
            busy={busy}
            description={description}
            error={error}
            hasDraft={draft !== undefined}
            onDescription={setDescription}
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
              Describe the agent and press Draft. The draft shows here, and
              every part of it stays editable.
            </p>
          ) : (
            <DraftCard
              address={address}
              catalog={catalog}
              draft={draft}
              gaps={gaps}
              locked={locked}
              onAddress={setAddressEdit}
              onEdit={edit}
            />
          )}
          {/* V3.13 adds the dry-run panel and "Create agent" here. */}
          <div data-slot="dry-run" />
        </div>
      </div>
    </section>
  );
}
