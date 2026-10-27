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

export interface ArtifactFrameProps {
  className?: string;
  contentUrl: string;
  /** False blocks pointer events, so a thread preview doesn't catch scrolling. */
  interactive: boolean;
  title: string;
  version: { createdAt: string; number: number };
  viewer: "member" | "link";
}

interface PendingLink {
  resolve: (agreed: boolean) => void;
  url: string;
}

const currentTheme = (): "light" | "dark" =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

/**
 * The sandboxed iframe plus the frame side of the bridge (R1.18, R1.20,
 * R1.21). The sandbox attribute is exactly `allow-scripts allow-forms`.
 */
export function ArtifactFrame({
  className,
  contentUrl,
  interactive,
  title,
  version,
  viewer,
}: ArtifactFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FrameBridge | null>(null);
  const [blanked, setBlanked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  // The bridge reads the latest values without being rebuilt on every render.
  const initRef = useRef({ version, viewer });
  initRef.current = { version, viewer };

  useEffect(() => {
    if (blanked) {
      return;
    }
    const bridge = createFrameBridge({
      confirmOpenLink: (url) =>
        new Promise<boolean>((resolve) => {
          setPendingLink({ resolve, url });
        }),
      getInit: () => ({
        theme: currentTheme(),
        version: initRef.current.version,
        viewer: initRef.current.viewer,
      }),
      getTarget: () => iframeRef.current?.contentWindow ?? null,
      onBlank: () => setBlanked(true),
      openLink: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    });
    bridgeRef.current = bridge;
    const onMessage = (event: MessageEvent) =>
      bridge.handleWindowMessage(event);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [blanked]);

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
        key={`${contentUrl}:${reloadKey}`}
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
