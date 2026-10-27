import type { ArtifactsOpenOutput } from "@repo/protocol/artifacts";
import {
  createFileRoute,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AccessLog } from "#/components/artifacts/access-log.tsx";
import { ArtifactFrame } from "#/components/artifacts/artifact-frame.tsx";
import { ShareDialog } from "#/components/artifacts/share-dialog.tsx";
import { HandToDialog } from "#/components/artifacts/viewer/hand-to-dialog.tsx";
import { VersionHistorySheet } from "#/components/artifacts/viewer/version-history-sheet.tsx";
import { ViewerBar } from "#/components/artifacts/viewer/viewer-bar.tsx";
import {
  buildViewerPath,
  type PromoteState,
  parseVersionSearch,
  shownVersionNumber,
} from "#/components/artifacts/viewer/viewer-logic.ts";
import {
  type PinSurface,
  pinnedSurfaces,
  pinToast,
  togglePinned,
} from "#/components/artifacts/viewer/viewer-menu-model.ts";
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
import { Spinner } from "#/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/a/$artifactId")({
  component: ArtifactViewerPage,
  loader: async ({ params }) => {
    try {
      const trpc = getTrpc();
      const [detail, versions] = await Promise.all([
        trpc.artifacts.get.query({ artifactId: params.artifactId }),
        trpc.artifacts.versions.query({ artifactId: params.artifactId }),
      ]);
      return { detail, versions };
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      if (
        error instanceof TRPCClientError &&
        (error.data?.code === "NOT_FOUND" || error.data?.code === "FORBIDDEN")
      ) {
        throw notFound();
      }
      throw error;
    }
  },
  notFoundComponent: ArtifactNotFound,
  validateSearch: (search: Record<string, unknown>): { v?: number } => {
    const v = parseVersionSearch(search.v);
    return v === undefined ? {} : { v };
  },
});

function ArtifactNotFound() {
  return (
    <main className="flex h-dvh items-center justify-center p-6 text-center">
      <p className="text-muted-foreground text-sm">
        This artifact is not available.
      </p>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

type OpenState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { opened: ArtifactsOpenOutput; status: "ready" };

function ArtifactViewerPage() {
  const { detail, versions } = Route.useLoaderData();
  const { v } = Route.useSearch();
  const { artifactId } = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<OpenState>({ status: "loading" });
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [handToOpen, setHandToOpen] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<PinSurface>>(new Set());
  const [promoting, setPromoting] = useState(false);
  const [waitingVersionId, setWaitingVersionId] = useState<string | null>(null);
  const [tab, setTab] = useState<"artifact" | "log">("artifact");

  const currentNumber = detail.currentVersion.number;
  const shownNumber = shownVersionNumber(detail, v);
  // The shown version's files other than its entry, for the share dialog.
  const shownVersion = versions.find((item) => item.number === shownNumber);
  const dataFiles = shownVersion?.files
    ?.filter((file) => file.path !== shownVersion.entry)
    .map(({ path, size }) => ({ path, size }));

  // One open per version shown, and a new one after a restore bumps the
  // current version. Each open writes a log row.
  useEffect(() => {
    let cancelled = false;
    setOpen({ status: "loading" });
    getTrpc()
      .artifacts.open.mutate({
        artifactId,
        surface: "viewer",
        version: v ?? currentNumber,
      })
      .then((opened) => {
        if (!cancelled) {
          setOpen({ opened, status: "ready" });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOpen({ message: errorMessage(error), status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, v, currentNumber]);

  // The caller's pins load in the browser only; a failure reads as no pins.
  useEffect(() => {
    let cancelled = false;
    getTrpc()
      .artifacts.pins.query({})
      .then((pins) => {
        if (!cancelled) {
          setPinned(pinnedSurfaces(pins, artifactId));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const showVersion = useCallback(
    (number: number) => {
      navigate({
        params: { artifactId },
        search: number === currentNumber ? {} : { v: number },
        to: "/a/$artifactId",
      });
    },
    [artifactId, currentNumber, navigate]
  );

  const run = useCallback(
    async (action: () => Promise<unknown>, success?: string) => {
      try {
        await action();
        if (success) {
          toast.success(success);
        }
        await router.invalidate();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [router]
  );

  const setAudience = useCallback(
    (audience: "private" | "workspace") =>
      run(() =>
        getTrpc().artifacts.setAudience.mutate({ artifactId, audience })
      ),
    [artifactId, run]
  );
  const rename = useCallback(
    (title: string) =>
      run(() => getTrpc().artifacts.rename.mutate({ artifactId, title })),
    [artifactId, run]
  );
  const restore = useCallback(
    (number: number) =>
      run(async () => {
        await getTrpc().artifacts.restore.mutate({
          artifactId,
          version: number,
        });
        navigate({ params: { artifactId }, search: {}, to: "/a/$artifactId" });
      }, `Restored v${number} as a new version`),
    [artifactId, navigate, run]
  );
  const shownVersionId = shownVersion?.id ?? null;
  let promoteState: PromoteState = "idle";
  if (promoting) {
    promoteState = "working";
  } else if (waitingVersionId !== null && waitingVersionId === shownVersionId) {
    promoteState = "waiting";
  }
  const promote = useCallback(async () => {
    if (!shownVersion) {
      return;
    }
    setPromoting(true);
    try {
      await getTrpc().artifacts.promote.mutate({
        artifactId,
        versionId: shownVersion.id,
      });
      toast.success(`Promoted v${shownVersion.number}`);
      await router.invalidate();
    } catch (error) {
      if (error instanceof TRPCClientError && error.data?.code === "CONFLICT") {
        setWaitingVersionId(shownVersion.id);
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setPromoting(false);
    }
  }, [artifactId, router, shownVersion]);
  const togglePin = useCallback(
    async (surface: PinSurface) => {
      const wasPinned = pinned.has(surface);
      try {
        const trpc = getTrpc();
        await (wasPinned
          ? trpc.artifacts.unpin.mutate({ artifactId, surface })
          : trpc.artifacts.pin.mutate({ artifactId, surface }));
        setPinned((current) => togglePinned(current, surface));
        toast.success(pinToast(surface, !wasPinned));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [artifactId, pinned]
  );
  const openHandTo = useCallback(() => setHandToOpen(true), []);
  const handedTo = useCallback(() => {
    router.invalidate();
  }, [router]);
  const copyLink = useCallback(() => {
    const path = buildViewerPath(artifactId, v, currentNumber);
    navigator.clipboard
      .writeText(`${window.location.origin}${path}`)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Could not copy the link"));
  }, [artifactId, currentNumber, v]);
  const fullScreen = useCallback(() => {
    frameWrapRef.current?.requestFullscreen().catch(() => {
      toast.error("Full screen is not available");
    });
  }, []);
  const viewVersion = useCallback(
    (number: number) => {
      setHistoryOpen(false);
      showVersion(number);
    },
    [showVersion]
  );
  const confirmDelete = useCallback(async () => {
    try {
      await getTrpc().artifacts.remove.mutate({ artifactId });
      navigate({ to: "/artifacts" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [artifactId, navigate]);
  const openDelete = useCallback(() => setDeleteOpen(true), []);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const openShare = useCallback(() => setShareOpen(true), []);
  const changeTab = useCallback(
    (value: string) => setTab(value === "log" ? "log" : "artifact"),
    []
  );

  return (
    <main className="flex h-dvh flex-col bg-background">
      <ViewerBar
        detail={detail}
        onAudience={setAudience}
        onCopyLink={copyLink}
        onDelete={openDelete}
        onFullScreen={fullScreen}
        onHandTo={openHandTo}
        onHistory={openHistory}
        onPromote={promote}
        onRename={rename}
        onShare={openShare}
        onTogglePin={togglePin}
        onVersion={showVersion}
        pinned={pinned}
        promoteState={promoteState}
        shownNumber={shownNumber}
        versions={versions}
      />
      {detail.canManage ? (
        <Tabs
          className="shrink-0 border-border border-b px-3"
          onValueChange={changeTab}
          value={tab}
        >
          <TabsList variant="line">
            <TabsTrigger className="h-10 md:h-8" value="artifact">
              Artifact
            </TabsTrigger>
            <TabsTrigger className="h-10 md:h-8" value="log">
              Access log
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {tab === "log" && detail.canManage ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <AccessLog artifactId={artifactId} />
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 items-center justify-center bg-background"
          ref={frameWrapRef}
        >
          {open.status === "loading" ? <Spinner /> : null}
          {open.status === "error" ? (
            <p className="p-6 text-center text-muted-foreground text-sm">
              {open.message}
            </p>
          ) : null}
          {open.status === "ready" ? (
            <ArtifactFrame
              className="h-full w-full"
              contentUrl={open.opened.contentUrl}
              interactive
              preview={shownVersion?.status === "proposed"}
              title={detail.title}
              version={open.opened.version}
              viewer="member"
            />
          ) : null}
        </div>
      )}
      <ShareDialog
        artifactId={artifactId}
        dataFiles={dataFiles}
        onOpenChange={setShareOpen}
        open={shareOpen}
      />
      <HandToDialog
        artifactId={artifactId}
        currentAgentId={detail.handedToAgentId}
        onOpenChange={setHandToOpen}
        onSaved={handedTo}
        open={handToOpen}
      />
      <VersionHistorySheet
        canRestore={detail.canManage}
        currentNumber={currentNumber}
        onOpenChange={setHistoryOpen}
        onRestore={restore}
        onView={viewVersion}
        open={historyOpen}
        shownNumber={shownNumber}
        versions={versions}
      />
      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {detail.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              The artifact and its links stop working. This cannot be undone
              from the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} variant="destructive">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
