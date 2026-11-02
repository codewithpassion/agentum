import { useOrganizationList, useSession } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { useSwitchWorkspace } from "#/components/rail/use-switch-workspace";
import { WorkspaceChoiceList } from "#/components/rail/workspace-choice-list";
import { workspaceChoices } from "#/components/rail/workspace-menu-logic";
import { pickerTarget } from "#/integrations/clerk/picker-redirect";
import { getTrpc } from "#/integrations/trpc/client";

const MINE_POLL_MS = 5 * 60_000;

export const Route = createFileRoute("/choose-organization")({
  component: ChooseOrganizationPage,
  validateSearch: (raw: Record<string, unknown>) => ({
    redirect: typeof raw.redirect === "string" ? raw.redirect : undefined,
  }),
});

// Where the provider's taskUrls send a user who signed in without an active
// organisation, so the step stays on the app's origin. It lists only the
// workspaces `workspaces.mine` returns, the person's organisations that have a
// `workspaces` row, and offers no way to make an organisation or accept an
// invitation: both would change memberships in Clerk organisations that may
// belong to another app. The server reads the pending session's user itself,
// so the list is never one the browser supplied.
function ChooseOrganizationPage() {
  const { redirect } = Route.useSearch();
  const { isLoaded, session } = useSession();
  if (!isLoaded) {
    return <Centered>Loading</Centered>;
  }
  if (!session) {
    return (
      <Centered>
        <p className="text-sm">
          <a className="underline" href="/login">
            Sign in
          </a>{" "}
          to choose a workspace.
        </p>
      </Centered>
    );
  }
  return (
    <Centered>
      <Picker target={pickerTarget(redirect)} />
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
      {children}
    </main>
  );
}

function Picker({ target }: { target: string }) {
  const { userMemberships } = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 100 },
  });
  const { data: mine, error: loadError } = usePolledQuery(
    () => getTrpc().workspaces.mine.query(),
    null,
    MINE_POLL_MS
  );
  const { error, switchTo } = useSwitchWorkspace(target);
  if (mine === null && loadError === null) {
    return <p className="text-sm">Loading</p>;
  }
  const choices = workspaceChoices({
    activeOrgId: null,
    mine: mine ?? [],
    orgs: (userMemberships.data ?? []).map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
    })),
  });
  return (
    <WorkspaceChoiceList
      choices={choices}
      error={
        error ?? (loadError === null ? null : "Could not load your workspaces.")
      }
      onChoose={switchTo}
      subject="This session"
    />
  );
}
