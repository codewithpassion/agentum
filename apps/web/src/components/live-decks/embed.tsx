import { parseArtifactContentPath } from "@repo/protocol/artifacts";
import { parseEmbedSource } from "@repo/protocol/deck";
import { useEffect, useState } from "react";
import { contentRef } from "../artifacts/content-ref";
import { SandboxArtifactFrame } from "../artifacts/sandbox-frame";
import type { DeckEditorPorts } from "./ports";

/** Resolve only on an authenticated deck-bound port. Never persist or accept a content URL as scene data. */
export function DeckEmbed({
  source,
  resolve,
  interactive,
}: {
  source: string;
  resolve: DeckEditorPorts["resolveEmbed"];
  interactive: boolean;
}) {
  const [opened, setOpened] = useState<{
    source: string;
    contentUrl: string;
    expiresAt: string;
  }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setOpened(undefined);
    setError(undefined);
    const refresh = async () => {
      if (!(resolve && parseEmbedSource(source))) {
        return;
      }
      try {
        const next = await resolve(source);
        const identity = parseEmbedSource(source);
        const served = parseArtifactContentPath(next.contentUrl);
        const ref = contentRef(next.contentUrl);
        if (
          !(identity && served && next.contentUrl.startsWith("/a/")) ||
          served.artifactId !== identity.artifactId ||
          served.path !== identity.path ||
          ref?.versionId !== identity.versionId ||
          !Number.isFinite(Date.parse(next.expiresAt))
        ) {
          throw new Error("Invalid embed content identity");
        }
        if (disposed) {
          return;
        }
        setOpened((previous) =>
          previous?.source === source &&
          Date.parse(previous.expiresAt) > Date.now() + 30_000
            ? previous
            : { ...next, source }
        );
        timer = setTimeout(
          refresh,
          Math.max(
            1000,
            Math.min(
              next.recheckAfterMs ?? Number.POSITIVE_INFINITY,
              Date.parse(next.expiresAt) - Date.now() - 30_000
            )
          )
        );
      } catch {
        if (!disposed) {
          setOpened(undefined);
          setError("Embed source is unavailable or access was refused.");
        }
      }
    };
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [source, resolve]);
  if (!resolve) {
    return <div role="status">Embed requires authorized deck access.</div>;
  }
  if (error) {
    return <div role="alert">{error}</div>;
  }
  if (!opened || opened.source !== source) {
    return <div role="status">Loading sandboxed embed…</div>;
  }
  return (
    <SandboxArtifactFrame
      className="ld-embed"
      contentUrl={opened.contentUrl}
      interactive={interactive}
      preview
      title="Sandboxed deck embed"
      version={{ createdAt: "", number: 0 }}
      viewer="link"
    />
  );
}
