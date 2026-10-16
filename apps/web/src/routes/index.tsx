import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/")({
  // `me` answers 401 unless the caller is a user in an allowed organisation.
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
    throw redirect({ to: "/agents" });
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
        <Button asChild>
          <a href="/login">Sign in</a>
        </Button>
      </section>
    </main>
  );
}
