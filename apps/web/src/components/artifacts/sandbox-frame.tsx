import type { PageElement } from "@repo/protocol/element-ask";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { createFrameBridge, type FrameBridge } from "./frame-bridge.ts";
import { createCallHandlers, type FrameCalls } from "./frame-calls.ts";

export interface ArtifactFrameProps {
  className?: string;
  contentUrl: string;
  createCalls?: () => FrameCalls | null;
  /** Enabled only by a member host with real message handlers. */
  elementAsk?: boolean;
  /** False blocks pointer events, so a thread preview doesn't catch scrolling. */
  interactive: boolean;
  /** Takes a `ui/message` from the page. Without it the frame refuses them. */
  onMessage?: (
    text: string,
    context?: { element: PageElement; requestId: string }
  ) => void | Promise<void>;
  /** A proposed version: unreviewed code, so the frame answers none of its tool or storage calls. */
  preview?: boolean;
  /** The share token, for a `link` viewer's live calls. */
  shareToken?: string;
  title: string;
  version: { createdAt: string; number: number };
  viewer: "member" | "link";
}

interface PendingLink {
  resolve: (agreed: boolean) => void;
  url: string;
}

/** 128 random bits as hex, for the iframe's `name`, which the bridge sends back. */
const newNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

const currentTheme = (): "light" | "dark" =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

/**
 * The sandboxed iframe plus the frame side of the bridge (R1.18, R1.20,
 * R1.21). The sandbox attribute is exactly `allow-scripts allow-forms`.
 */
export function SandboxArtifactFrame({
  createCalls,
  elementAsk = false,
  className,
  contentUrl,
  interactive,
  onMessage,
  preview = false,
  shareToken,
  title,
  version,
  viewer,
}: ArtifactFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FrameBridge | null>(null);
  const [blanked, setBlanked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Anything the bridge is built from restarts the iframe, since a page that
  // lost its port never handshakes again.
  const takesMessages = onMessage !== undefined;
  const frameKey = `${contentUrl}:${reloadKey}:${viewer}:${shareToken ?? ""}:${takesMessages}:${preview}:${elementAsk}`;
  // A fresh nonce for every iframe this component mounts. It travels in the
  // iframe's name, so every page loaded in the frame has it: the gate keeps
  // out pages that never read it, like one that cleared `window.name`.
  const [issued, setIssued] = useState(() => ({
    key: frameKey,
    nonce: newNonce(),
  }));
  if (issued.key !== frameKey) {
    setIssued({ key: frameKey, nonce: newNonce() });
  }
  const { nonce } = issued;
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  // Mirrors `pendingLink` so the bridge callbacks can refuse a prompt that is
  // still open when the frame blanks or goes away.
  const pendingLinkRef = useRef<PendingLink | null>(null);
  pendingLinkRef.current = pendingLink;
  const dropPendingLink = useCallback(() => {
    pendingLinkRef.current?.resolve(false);
    setPendingLink(null);
  }, []);
  // The bridge reads the latest values without being rebuilt on every render.
  const initRef = useRef({ version, viewer });
  initRef.current = { version, viewer };
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (blanked) {
      return;
    }
    const calls = preview ? null : createCalls?.();
    const bridge = createFrameBridge({
      confirmOpenLink: (url) =>
        new Promise<boolean>((resolve) => {
          setPendingLink({ resolve, url });
        }),
      extraHandlers: calls
        ? createCallHandlers({
            calls,
            onMessage: takesMessages
              ? (text, context) => onMessageRef.current?.(text, context)
              : undefined,
          })
        : undefined,
      getInit: () => ({
        elementAsk:
          elementAsk &&
          takesMessages &&
          calls?.viewer === "member" &&
          viewer === "member" &&
          !preview,
        theme: currentTheme(),
        version: initRef.current.version,
        viewer: initRef.current.viewer,
      }),
      getTarget: () => iframeRef.current?.contentWindow ?? null,
      nonce,
      onBlank: () => {
        dropPendingLink();
        setBlanked(true);
      },
      openLink: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    });
    bridgeRef.current = bridge;
    const onWindowMessage = (event: MessageEvent) =>
      bridge.handleWindowMessage(event);
    window.addEventListener("message", onWindowMessage);
    return () => {
      window.removeEventListener("message", onWindowMessage);
      bridge.dispose();
      bridgeRef.current = null;
      dropPendingLink();
    };
  }, [
    blanked,
    createCalls,
    dropPendingLink,
    elementAsk,
    nonce,
    preview,
    takesMessages,
    viewer,
  ]);

  const handleLoad = useCallback(() => bridgeRef.current?.handleLoad(), []);
  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
    setBlanked(false);
  }, []);

  const answerLink = useCallback(
    (agreed: boolean) => {
      pendingLink?.resolve(agreed);
      setPendingLink(null);
    },
    [pendingLink]
  );

  const refuseLink = useCallback(
    (next: boolean) => {
      if (!next) {
        answerLink(false);
      }
    },
    [answerLink]
  );
  const allowLink = useCallback(() => answerLink(true), [answerLink]);

  if (blanked) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 p-6 text-center",
          className
        )}
        data-testid="artifact-frame-blanked"
        role="alert"
      >
        <p className="font-medium text-sm">
          This artifact tried to leave its page
        </p>
        <Button onClick={reload} size="sm" variant="outline">
          Reload
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("relative", className)} data-testid="artifact-frame">
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the iframe `load` event is not a user interaction, it drives the R1.21 check */}
      <iframe
        allow="clipboard-write"
        className={cn(
          "h-full w-full border-0 bg-background",
          !interactive && "pointer-events-none"
        )}
        key={frameKey}
        name={nonce}
        onLoad={handleLoad}
        ref={iframeRef}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms"
        src={contentUrl}
        title={title}
      />
      <AlertDialog onOpenChange={refuseLink} open={pendingLink !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open this link?</AlertDialogTitle>
            <AlertDialogDescription>
              This artifact wants to open a link in a new tab. Only continue if
              you trust it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all rounded-md bg-muted p-2 text-xs">
            {pendingLink?.url}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={allowLink}>Open link</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
