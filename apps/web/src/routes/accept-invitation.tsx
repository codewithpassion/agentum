import {
  SignIn,
  SignUp,
  useOrganizationList,
  useSession,
} from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  invitationReturnPath,
  invitationStep,
  parseInvitationSearch,
} from "#/integrations/clerk/accept-invitation";

export const Route = createFileRoute("/accept-invitation")({
  component: AcceptInvitationPage,
  validateSearch: parseInvitationSearch,
});

// Where the email link from `workspaces.invite` lands. Clerk appends
// `__clerk_ticket` and `__clerk_status` to the redirect URL the server set, and
// the server adds `org`. The sign-up or sign-in form spends the ticket and
// returns here signed in, and `ActivateOrganization` then makes the inviting
// organisation active, so a person in several organisations still lands in
// the one that invited them.
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

function ActivateOrganization({ org }: { org: string }) {
  const { isLoaded, setActive } = useOrganizationList();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!(isLoaded && setActive) || started.current) {
      return;
    }
    started.current = true;
    setActive({ organization: org })
      .then(() => window.location.assign("/desk"))
      .catch(() =>
        setError("Could not open the workspace you were invited to.")
      );
  }, [isLoaded, org, setActive]);

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
  return <Centered>Opening your workspace</Centered>;
}
