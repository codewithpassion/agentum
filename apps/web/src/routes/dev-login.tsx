import { useUser } from "@clerk/tanstack-react-start";
// The signal-based `useSignIn` resolves its methods through `client.signIn`,
// which clerk-js swaps for a fresh, empty resource the moment a ticket is
// redeemed - so `finalize()` never sees the session `ticket()` just created.
// The legacy hook hands back the sign-in attempt itself, so the created session
// id survives that swap.
import { useSignIn } from "@clerk/tanstack-react-start/legacy";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/dev-login")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: DevLogin,
});

function DevLogin() {
  const { token } = Route.useSearch();
  const { isLoaded, setActive, signIn } = useSignIn();
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

    if (!isLoaded) {
      return;
    }

    // biome-ignore lint/suspicious/noUnnecessaryConditions: consumed.current is mutated below to guard against re-consuming a single-use ticket.
    if (consumed.current) {
      return;
    }
    consumed.current = true;

    (async () => {
      try {
        const attempt = await signIn.create({
          strategy: "ticket",
          ticket: token,
        });
        await setActive({ session: attempt.createdSessionId });
        window.location.href = "/";
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Dev login failed.");
      }
    })();
  }, [isLoaded, setActive, signIn, token, user]);

  if (error) {
    return (
      <main className="demo-page demo-center">
        <p className="demo-muted text-sm">{error}</p>
      </main>
    );
  }

  return (
    <main className="demo-page demo-center">
      <p className="demo-muted text-sm">Signing in…</p>
    </main>
  );
}
