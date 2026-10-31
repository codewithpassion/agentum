import { Link } from "@tanstack/react-router";
import {
  isEnded,
  peerHost,
  peerName,
  statusWords,
} from "#/components/connections/connections-logic.ts";
import type { RouterOutputs } from "#/integrations/trpc/types";

/**
 * The "Connections" side card: whether the agent is published, and the peers
 * it is connected to. A peer's name and host are outside text, shown plain.
 */
export function ConnectionsCard({
  connections,
  published,
}: {
  connections: RouterOutputs["a2a"]["list"];
  published: RouterOutputs["a2a"]["published"];
}) {
  const live = connections.filter((row) => !isEnded(row.status));
  const isPublished = published !== null && published.unpublishedAt === null;
  return (
    <section
      aria-label="Connections"
      className="min-w-0 rounded-lg border border-border bg-card"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Connections</h2>
      <p className="px-4 pb-2 text-muted-foreground text-xs">
        {isPublished
          ? "Published. Other agents can find this one and be connected to it."
          : "Not published. Nothing outside can reach this agent."}
      </p>
      <p className="px-4 pb-2 text-xs" data-testid="connections-count">
        {live.length === 0
          ? "No connections."
          : `${live.length} ${live.length === 1 ? "connection" : "connections"}`}
      </p>
      {live.length === 0 ? null : (
        <ul>
          {live.map((row) => {
            const host = peerHost(row);
            return (
              <li className="border-border border-t px-4 py-2" key={row.id}>
                <Link
                  className="block hover:underline"
                  params={{ connectionId: row.id }}
                  to="/settings/agent-connections/$connectionId"
                >
                  <span className="block truncate font-semibold text-sm">
                    {peerName(row)}
                  </span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {host === null ? "" : `${host}, `}
                    {statusWords(row.status)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-border border-t px-4 py-2.5">
        <Link
          className="pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center text-sm underline-offset-4 hover:underline"
          to="/settings/agent-connections"
        >
          Agent connections
        </Link>
      </div>
    </section>
  );
}
