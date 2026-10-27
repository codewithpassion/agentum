import { SHARE_UNAVAILABLE_MESSAGE } from "@repo/protocol/artifacts";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArtifactFrame } from "#/components/artifacts/artifact-frame.tsx";
import {
  openShare,
  type ShareOpenResult,
} from "#/components/artifacts/share/share-open.ts";
import { Spinner } from "#/components/ui/spinner";

export const Route = createFileRoute("/s/$token")({
  component: SharePage,
  head: () => ({ meta: [{ content: "noindex", name: "robots" }] }),
});

function SharePage() {
  const { token } = Route.useParams();
  const [result, setResult] = useState<ShareOpenResult | null>(null);
  // Strict mode runs effects twice, and each open writes a log row.
  const openedToken = useRef<string | null>(null);

  useEffect(() => {
    if (openedToken.current === token) {
      return;
    }
    openedToken.current = token;
    setResult(null);
    openShare(token).then((next) => {
      if (openedToken.current === token) {
        setResult(next);
      }
    });
  }, [token]);

  if (result === null) {
    return (
      <main className="flex h-dvh items-center justify-center">
        <Spinner />
      </main>
    );
  }

  if (!result.ok) {
    return (
      <main className="flex h-dvh items-center justify-center p-6 text-center">
        <p className="text-muted-foreground text-sm">
          {SHARE_UNAVAILABLE_MESSAGE}
        </p>
      </main>
    );
  }

  const { data } = result;
  return (
    <main className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-border border-b bg-background px-3 py-1.5 text-xs">
        <h1 className="min-w-0 max-w-full truncate font-medium text-sm">
          {data.title}
        </h1>
        <span className="text-muted-foreground">
          Shared from {data.workspaceName} on Harbourmaster
        </span>
        <span className="text-muted-foreground">
          Content is user-generated and unverified.
        </span>
        <span className="text-muted-foreground">
          Opens of this link are logged.
        </span>
      </header>
      <ArtifactFrame
        className="min-h-0 flex-1"
        contentUrl={data.contentUrl}
        interactive
        shareToken={token}
        title={data.title}
        version={data.version}
        viewer="link"
      />
    </main>
  );
}
