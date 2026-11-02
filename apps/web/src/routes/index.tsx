import {
  Show,
  SignOutButton,
  useOrganization,
  useOrganizationList,
} from "@clerk/tanstack-react-start";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { useSwitchWorkspace } from "#/components/rail/use-switch-workspace";
import { workspaceChoices } from "#/components/rail/workspace-menu-logic";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

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
});

function Landing() {
  return (
    <main className="page-wrap px-4 pt-14 pb-8">
      <section className="rise-in pt-6 pb-4 sm:pt-10">
        <h1 className="display-title mb-5 max-w-3xl text-5xl text-foreground leading-[1.05] sm:text-6xl">
          Harbourmaster
        </h1>
        <p className="mb-8 max-w-2xl text-base text-muted-foreground sm:text-lg">
          An agent platform.
        </p>
        <Show when="signed-out">
          <Button asChild>
            <a href="/login">Sign in</a>
          </Button>
        </Show>
        <Show when="signed-in">
          <NoAccess />
        </Show>
      </section>
    </main>
  );
}

const MINE_POLL_MS = 5 * 60_000;

function SwitchButton({
  id,
  name,
  onSwitch,
}: {
  id: string;
  name: string;
  onSwitch: (organizationId: string) => void;
}) {
  const choose = useCallback(() => onSwitch(id), [id, onSwitch]);
  return (
    <Button
      className="h-auto justify-start whitespace-normal break-words px-3 py-2 text-left"
      onClick={choose}
      type="button"
      variant="outline"
    >
      {name}
    </Button>
  );
}

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
  const subject = organization?.name ?? "This session";
  return (
    <div className="max-w-md space-y-4">
      <p className="font-medium">{subject} has no Harbourmaster workspace.</p>
      {choices.length > 0 ? (
        <>
          <p className="text-muted-foreground text-sm">
            Switch to one of your workspaces, or sign out and use another
            account.
          </p>
          <div className="flex flex-col items-stretch gap-2">
            {choices.map((choice) => (
              <SwitchButton
                id={choice.id}
                key={choice.id}
                name={choice.name}
                onSwitch={switchTo}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Ask a workspace admin to invite you, or sign out and use another
          account.
        </p>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <SignOutButton>
        <Button variant="outline">Sign out</Button>
      </SignOutButton>
    </div>
  );
}
