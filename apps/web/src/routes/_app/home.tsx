import type { AgentTemplateId } from "@repo/db/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { useRail, useRailScope } from "#/components/rail/use-rail";
import { FirstRunGuide } from "#/components/roster/first-run-guide";
import { chipsOf } from "#/components/roster/roster-logic";
import { RosterWall } from "#/components/roster/roster-wall";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const PAGE_HEADING = "Home";

/** The roster, and whether the workspace has an AI account yet (an Anthropic or an OpenRouter key). */
const loadHome = async () => {
  const trpc = getTrpc();
  const [cards, anthropic, openrouter] = await Promise.all([
    trpc.roster.list.query(),
    trpc.managedKeys.status.query(),
    trpc.modelKeys.status.query({ provider: "openrouter" }),
  ]);
  return {
    anthropic,
    cards,
    hasKey: anthropic.configured || openrouter.configured,
  };
};

export const Route = createFileRoute("/_app/home")({
  loader: async () => loadOrLogin(loadHome),
  component: Home,
});

function Home() {
  const loaded = Route.useLoaderData();
  const { data, refresh } = usePolledQuery(
    loadHome,
    loaded,
    DESK_POLL_INTERVAL_MS
  );
  const { scope } = useRailScope();
  const { needsYou } = useRail(scope, null);
  const navigate = useNavigate();
  const { anthropic, cards, hasKey } = data ?? loaded;

  const saveKey = useCallback(
    async (apiKey: string) => {
      await getTrpc().managedKeys.set.mutate({ apiKey });
      await refresh();
    },
    [refresh]
  );
  const pickTemplate = useCallback(
    (template: AgentTemplateId) =>
      navigate({ search: { template }, to: "/agents/new" }),
    [navigate]
  );
  // The description is already in session storage, where the builder reads it.
  const continueToBuilder = useCallback(
    () => navigate({ search: {}, to: "/agents/new" }),
    [navigate]
  );

  return (
    <section className="mx-auto max-w-6xl">
      <h1 className="mb-6 font-heading text-3xl text-foreground">
        {PAGE_HEADING}
      </h1>
      <RosterWall
        cards={cards}
        chips={chipsOf(needsYou)}
        emptyState={
          <FirstRunGuide
            anthropic={anthropic}
            hasKey={hasKey}
            onContinue={continueToBuilder}
            onPickTemplate={pickTemplate}
            onSaveKey={saveKey}
          />
        }
      />
    </section>
  );
}
