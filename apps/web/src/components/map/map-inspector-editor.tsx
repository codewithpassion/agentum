import { Link } from "@tanstack/react-router";
import { buttonVariants } from "#/components/ui/button.tsx";
import type { AgentRecord } from "#/integrations/trpc/types";

/** The room tabs that hold what the map used to edit in place. */
const EDIT_TABS = ["knows", "keys", "jobs", "settings"] as const;

const TAB_WORDS = {
  jobs: "Jobs",
  keys: "Keys",
  knows: "Knows",
  settings: "Settings",
} as const satisfies Record<(typeof EDIT_TABS)[number], string>;

/** Links into the agent room, where the rows and sheets of the old profile now live as tabs. */
export function AgentEditor({ agent }: { agent: AgentRecord }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {EDIT_TABS.map((tab) => (
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          key={tab}
          params={{ agentId: agent.id }}
          search={{ tab }}
          to="/agents/$agentId"
        >
          {TAB_WORDS[tab]}
        </Link>
      ))}
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        params={{ agentId: agent.id }}
        to="/agents/$agentId"
      >
        Open agent room
      </Link>
    </div>
  );
}
