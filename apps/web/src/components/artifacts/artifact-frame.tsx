import { useCallback } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { contentRef } from "./content-ref";
import {
  type FrameCalls,
  linkCallsFromFetch,
  memberCallsFromTrpc,
} from "./frame-calls";
import {
  SandboxArtifactFrame,
  type ArtifactFrameProps as SandboxFrameProps,
} from "./sandbox-frame";

export type ArtifactFrameProps = Omit<SandboxFrameProps, "createCalls">;

const callsFor = (
  viewer: "member" | "link",
  contentUrl: string,
  shareToken: string | undefined
): FrameCalls | null => {
  if (viewer === "link") {
    return shareToken
      ? { ...linkCallsFromFetch(shareToken), viewer: "link" }
      : null;
  }
  const ref = contentRef(contentUrl);
  return ref
    ? { ...memberCallsFromTrpc(getTrpc(), ref), viewer: "member" }
    : null;
};

/** Member/link bridge calls are wired here; deck embeds import the sandbox alone. */
export function ArtifactFrame(props: ArtifactFrameProps) {
  const { viewer, contentUrl, shareToken } = props;
  const createCalls = useCallback(
    () => callsFor(viewer, contentUrl, shareToken),
    [viewer, contentUrl, shareToken]
  );
  return <SandboxArtifactFrame {...props} createCalls={createCalls} />;
}
