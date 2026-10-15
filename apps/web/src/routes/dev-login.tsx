import { useClerk, useSignIn, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "#/components/ui/spinner";

export const Route = createFileRoute("/dev-login")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
    org: typeof search.org === "string" ? search.org : "",
  }),
  component: DevLogin,
});

function DevLogin() {
  const { token, org } = Route.useSearch();
  const { signIn } = useSignIn();
  const { user } = useUser();
  const { setActive } = useClerk();
  const [error, setError] = useState<string | null>(null);
  const consumed = useRef(false);

  useEffect(() => {
    if (user) {
      // Already signed in (e.g. an agent re-running the flow) - nothing to redeem.
      window.location.href = "/";
      return;
    }

    if (!token) {
      setError("Missing dev login token.");
      return;
    }

    // biome-ignore lint/suspicious/noUnnecessaryConditions: consumed.current is mutated below to guard against re-consuming a single-use ticket.
    if (consumed.current) {
      return;
    }
    consumed.current = true;

    (async () => {
      const { error: ticketError } = await signIn.ticket({ ticket: token });
      if (ticketError) {
        setError(ticketError.message ?? "Dev login failed.");
        return;
      }

      // finalize sets the session. Its navigate runs before that, so it must
      // not navigate: the page would leave before the organisation is set.
      const { error: finalizeError } = await signIn.finalize({
        navigate: () => undefined,
      });
      if (finalizeError) {
        setError(finalizeError.message ?? "Dev login failed.");
        return;
      }

      if (org) {
        await setActive({ organization: org });
      }
      window.location.href = "/";
    })();
  }, [token, org, signIn, user, setActive]);

  if (error) {
    return (
      <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
        <p className="text-muted-foreground text-sm">{error}</p>
      </main>
    );
  }

  return (
    <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner />
        Signing in…
      </p>
    </main>
  );
}
