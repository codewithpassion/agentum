import { createFileRoute } from "@tanstack/react-router";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { useRail, useRailScope } from "#/components/rail/use-rail";
import { chipsOf } from "#/components/roster/roster-logic";
import { RosterWall } from "#/components/roster/roster-wall";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const PAGE_HEADING = "Home";

const loadRoster = () => getTrpc().roster.list.query();

export const Route = createFileRoute("/_app/home")({
  loader: async () => loadOrLogin(loadRoster),
  component: Home,
});

function Home() {
  const loaded = Route.useLoaderData();
  const { data } = usePolledQuery(loadRoster, loaded, DESK_POLL_INTERVAL_MS);
  const { scope } = useRailScope();
  const { needsYou } = useRail(scope, null);

  return (
    <section className="mx-auto max-w-6xl">
      <h1 className="mb-6 font-heading text-3xl text-foreground">
        {PAGE_HEADING}
      </h1>
      <RosterWall cards={data ?? loaded} chips={chipsOf(needsYou)} />
    </section>
  );
}
