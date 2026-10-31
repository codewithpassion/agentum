import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ConnectInstructions } from "#/components/connections/connect-instructions.tsx";
import { Spinner } from "#/components/ui/spinner";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/connect/$token")({
  component: ConnectPage,
  head: () => ({ meta: [{ content: "noindex", name: "robots" }] }),
});

type Visitor = "checking" | "signed-in" | "signed-out";

/**
 * An invite link. Signed in on this deployment, it opens the join form with
 * the link filled in. Otherwise it shows how to use the link. It never looks
 * the token up, so it reveals nothing about the inviter before a join works.
 */
function ConnectPage() {
  const navigate = useNavigate();
  const [visitor, setVisitor] = useState<Visitor>("checking");
  const [link, setLink] = useState("");

  useEffect(() => {
    const here = window.location.href;
    setLink(here);
    getTrpc()
      .a2a.list.query({})
      .then(() => {
        setVisitor("signed-in");
        navigate({
          replace: true,
          search: { join: here },
          to: "/settings/agent-connections",
        });
      })
      .catch(() => setVisitor("signed-out"));
  }, [navigate]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      {visitor === "signed-out" ? (
        <ConnectInstructions link={link} />
      ) : (
        <Spinner />
      )}
    </main>
  );
}
