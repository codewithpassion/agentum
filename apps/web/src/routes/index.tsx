import {
  Show,
  useOrganization,
  useOrganizationList,
} from "@clerk/tanstack-react-start";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { useSwitchWorkspace } from "#/components/rail/use-switch-workspace";
import { WorkspaceChoiceList } from "#/components/rail/workspace-choice-list";
import { workspaceChoices } from "#/components/rail/workspace-menu-logic";
import { getTrpc } from "#/integrations/trpc/client";
import { AuthPanel, LandingPage, PublicShell } from "#/modules/landing";

const TITLE = "Agentum | Agents that do the work";
const DESCRIPTION =
  "Describe an agent in plain words. Give it tools, a schedule and a computer. When it needs a decision, it asks you.";

export const Route = createFileRoute("/")({
  // `me` answers 401 unless the caller is a user whose active organisation has a workspace row.
  // Success means the shell, 401 means the landing page.
  beforeLoad: async () => {
    try {
      await getTrpc().me.query();
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    }
    throw redirect({ to: "/desk" });
  },
  component: Landing,
  head: () => ({
    meta: [
      { title: TITLE },
      { content: DESCRIPTION, name: "description" },
      { content: TITLE, property: "og:title" },
      { content: DESCRIPTION, property: "og:description" },
    ],
  }),
});

const PUBLIC_LINKS = [{ href: "/", label: "Home", secondary: true }];

function Landing() {
  return (
    <>
      <Show when="signed-out">
        <LandingPage signInHref="/login" />
      </Show>
      <Show when="signed-in">
        <PublicShell homeHref="/" links={PUBLIC_LINKS}>
          {/* The app's dark tokens, so the shadcn controls read on DF black. */}
          <AuthPanel className="dark">
            <NoAccess />
          </AuthPanel>
        </PublicShell>
      </Show>
    </>
  );
}

const MINE_POLL_MS = 5 * 60_000;

// A signed-in user reaches the landing page only when `me` answered 401: the
// active organisation is missing or has no workspace row. The list is the
// organisations that do have a row, not everything Clerk knows the person in.
function NoAccess() {
  const { organization } = useOrganization();
  const { userMemberships } = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 100 },
  });
  const { data: mine } = usePolledQuery(
    () => getTrpc().workspaces.mine.query(),
    null,
    MINE_POLL_MS
  );
  const { error, switchTo } = useSwitchWorkspace();
  const choices = workspaceChoices({
    activeOrgId: organization?.id ?? null,
    mine: mine ?? [],
    orgs: (userMemberships.data ?? []).map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
    })),
  });
  return (
    <WorkspaceChoiceList
      choices={choices}
      error={error}
      onChoose={switchTo}
      subject={organization?.name ?? "This session"}
    />
  );
}
