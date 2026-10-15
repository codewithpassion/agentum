import { useSignIn, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "#/components/ui/spinner";

export const Route = createFileRoute("/dev-login")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: DevLogin,
});

function DevLogin() {
  const { token } = Route.useSearch();
  const { signIn } = useSignIn();
  const { user } = useUser();
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

      const { error: finalizeError } = await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          window.location.href = decorateUrl("/");
        },
      });
      if (finalizeError) {
        setError(finalizeError.message ?? "Dev login failed.");
      }
    })();
  }, [token, signIn, user]);

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
