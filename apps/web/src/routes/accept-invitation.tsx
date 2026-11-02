import {
  SignIn,
  SignUp,
  useOrganizationList,
  useSession,
} from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  activationPlan,
  invitationReturnPath,
  invitationStep,
  parseInvitationSearch,
} from "#/integrations/clerk/accept-invitation";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/accept-invitation")({
  component: AcceptInvitationPage,
  validateSearch: parseInvitationSearch,
});

// Where the email link from `workspaces.invite` lands. Clerk appends
// `__clerk_ticket` and `__clerk_status` to the redirect URL the server set, and
// the server adds `org`. The sign-up or sign-in form spends the ticket and
// returns here signed in, and `ActivateOrganization` then checks that the
// organisation has a `workspaces` row and makes it active, so a person in
// several organisations still lands in the one that invited them. A person who
// arrives already signed in, with the invitation still pending, must click
// `Join` before it is accepted.
function AcceptInvitationPage() {
  const search = Route.useSearch();
  const { isLoaded, session } = useSession();
  if (!isLoaded) {
    return <Centered>Loading</Centered>;
  }
  const step = invitationStep({ search, signedIn: Boolean(session) });
  switch (step.kind) {
    case "activate":
      return <ActivateOrganization org={step.org} />;
    case "desk":
      return <GoToDesk />;
    case "sign-up":
      return (
        <Centered>
          <SignUp
            forceRedirectUrl={invitationReturnPath(search.org)}
            routing="hash"
            signInForceRedirectUrl={invitationReturnPath(search.org)}
          />
        </Centered>
      );
    default:
      return (
        <Centered>
          <SignIn
            forceRedirectUrl={invitationReturnPath(search.org)}
            routing="hash"
            signUpForceRedirectUrl={invitationReturnPath(search.org)}
          />
        </Centered>
      );
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
      {children}
    </main>
  );
}

function GoToDesk() {
  useEffect(() => {
    window.location.assign("/desk");
  }, []);
  return <Centered>Opening your workspace</Centered>;
}

type RowState = "loading" | "yes" | "no" | "failed";

function ActivateOrganization({ org }: { org: string }) {
  const { isLoaded, setActive, userInvitations, userMemberships } =
    useOrganizationList({
      userInvitations: { infinite: true, pageSize: 100, status: "pending" },
      userMemberships: { infinite: true, pageSize: 100 },
    });
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [row, setRow] = useState<RowState>("loading");
  const loading =
    !isLoaded ||
    userMemberships.isLoading ||
    userInvitations.isLoading ||
    row === "loading";

  useEffect(() => {
    let current = true;
    getTrpc()
      .workspaces.hasWorkspace.query({ org })
      .then((result) => current && setRow(result.exists ? "yes" : "no"))
      .catch(() => current && setRow("failed"));
    return () => {
      current = false;
    };
  }, [org]);

  const confirm = useCallback(() => setConfirmed(true), []);

  const plan = loading
    ? null
    : activationPlan({
        confirmed,
        hasRow: row === "yes",
        invitations: (userInvitations.data ?? []).map((pending) => ({
          id: pending.id,
          organizationId: pending.publicOrganizationData.id,
        })),
        memberOrgIds: (userMemberships.data ?? []).map(
          (membership) => membership.organization.id
        ),
        org,
      });
  const invitation =
    plan && "invitationId" in plan
      ? (userInvitations.data ?? []).find(
          (candidate) => candidate.id === plan.invitationId
        )
      : undefined;

  useEffect(() => {
    if (!(plan && setActive) || started.current) {
      return;
    }
    if (plan.kind === "none") {
      started.current = true;
      setError(
        row === "failed"
          ? "Could not open the workspace you were invited to."
          : "This invitation is not for the account you are signed in with."
      );
      return;
    }
    if (plan.kind === "confirm") {
      return;
    }
    started.current = true;
    Promise.resolve(plan.kind === "accept" ? invitation?.accept() : undefined)
      .then(() => setActive({ organization: org }))
      .then(() => window.location.assign("/desk"))
      .catch(() =>
        setError("Could not open the workspace you were invited to.")
      );
  }, [plan, row, invitation, org, setActive]);

  if (error !== null) {
    return (
      <Centered>
        <div className="space-y-4">
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
          <Button asChild variant="outline">
            <Link to="/">Go to Harbourmaster</Link>
          </Button>
        </div>
      </Centered>
    );
  }
  if (plan?.kind === "confirm" && invitation) {
    return (
      <Centered>
        <div className="space-y-4">
          <p className="text-sm">
            Join {invitation.publicOrganizationData.name}?
          </p>
          <Button onClick={confirm}>Join</Button>
        </div>
      </Centered>
    );
  }
  return <Centered>Opening your workspace</Centered>;
}
