import type { ArtifactKind } from "@repo/db/shared";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PuzzleIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { useIsMobile } from "#/hooks/use-mobile.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { cn } from "#/lib/utils.ts";

// The frame is the heavy part of the card, so its code loads with the first preview.
const LazyArtifactFrame = lazy(async () => {
  const module = await import("./artifact-frame.tsx");
  return { default: module.ArtifactFrame };
});

/** Height of the live preview in the thread. */
export const THREAD_PREVIEW_HEIGHT_PX = 360;

/** What the card shows: the fields of the `artifact` thread part. */
export interface ThreadCardArtifact {
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  version: number;
}

/** The opened version, as `artifacts.open` returns it. */
export interface ThreadCardPreview {
  contentUrl: string;
  createdAt: string;
  number: number;
  /** A proposed version: the frame answers none of its tool or storage calls. */
  preview?: boolean;
}

const KIND_ICONS: Record<ArtifactKind, LucideIcon> = {
  app: PuzzleIcon,
  dashboard: LayoutDashboardIcon,
  deck: LayoutDashboardIcon,
  doc: FileTextIcon,
  document: FileTextIcon,
  page: GlobeIcon,
};

const isArtifactKind = (value: unknown): value is ArtifactKind =>
  typeof value === "string" && value in KIND_ICONS;

/** The card's fields from a `data-artifact` part's data, or null when it does not fit. */
export const threadCardArtifactOf = (
  data: unknown
): ThreadCardArtifact | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const { artifactId, kind, title, version } = data as Record<string, unknown>;
  return typeof artifactId === "string" &&
    isArtifactKind(kind) &&
    typeof title === "string" &&
    typeof version === "number"
    ? { artifactId, kind, title, version }
    : null;
};

/** Where Open goes: the framed viewer. */
export const artifactViewerHref = (artifactId: string): string =>
  `/a/${artifactId}`;

/** The version's screenshot, which the phone card shows. */
export const artifactThumbnailSrc = (artifact: ThreadCardArtifact): string =>
  `/api/artifacts/${artifact.artifactId}/thumbnail?version=${artifact.version}`;

function KindIcon({ kind }: { kind: ArtifactKind }) {
  const Icon = KIND_ICONS[kind];
  return <Icon aria-hidden className="size-4 shrink-0" data-kind={kind} />;
}

/** The thumbnail, or the kind icon when the version has none. */
function Thumbnail({ artifact }: { artifact: ThreadCardArtifact }) {
  const [missing, setMissing] = useState(false);
  const handleError = useCallback(() => setMissing(true), []);
  if (missing) {
    return (
      <div
        className="flex h-24 items-center justify-center rounded-md bg-muted text-muted-foreground"
        data-testid="thread-card-thumbnail-fallback"
      >
        <KindIcon kind={artifact.kind} />
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError only swaps in the icon when the thumbnail is missing.
    <img
      alt={`Preview of ${artifact.title}`}
      className="max-h-48 w-full rounded-md border object-cover object-top"
      data-testid="thread-card-thumbnail"
      height={192}
      onError={handleError}
      src={artifactThumbnailSrc(artifact)}
      width={384}
    />
  );
}

export interface ThreadCardViewProps {
  artifact: ThreadCardArtifact;
  /** Whether the preview takes mouse and touch input, or the overlay catches it. */
  interactive: boolean;
  onInteract: () => void;
  onLeave: () => void;
  /** Null until `artifacts.open` answers. */
  preview: ThreadCardPreview | null;
  variant: "desktop" | "phone";
}

/** The card as pure markup: title row, then the live preview (desktop) or the thumbnail (phone). */
export function ThreadCardView({
  artifact,
  interactive,
  onInteract,
  onLeave,
  preview,
  variant,
}: ThreadCardViewProps) {
  return (
    <div
      className="flex w-full flex-col gap-2 rounded-lg border bg-card p-3"
      data-testid="thread-card"
      data-variant={variant}
    >
      <div className="flex items-center gap-2">
        <KindIcon kind={artifact.kind} />
        <p className="min-w-0 flex-1 truncate font-medium text-sm">
          {artifact.title}
        </p>
        <span className="text-muted-foreground text-xs">
          v{artifact.version}
        </span>
        <Button asChild className="max-md:min-h-10" size="sm" variant="outline">
          <a href={artifactViewerHref(artifact.artifactId)}>
            Open
            <ExternalLinkIcon aria-hidden />
          </a>
        </Button>
      </div>
      {variant === "phone" ? (
        <Thumbnail artifact={artifact} />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only hands scrolling back to the thread when the pointer leaves.
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the wrapper only hands scrolling back to the thread when the pointer leaves.
        <div
          className="relative overflow-hidden rounded-md border"
          data-testid="thread-card-preview"
          onMouseLeave={onLeave}
          style={{ height: THREAD_PREVIEW_HEIGHT_PX }}
        >
          {preview === null ? (
            <Skeleton className="size-full" />
          ) : (
            <Suspense fallback={<Skeleton className="size-full" />}>
              <LazyArtifactFrame
                className={cn("size-full")}
                contentUrl={preview.contentUrl}
                interactive={interactive}
                preview={preview.preview}
                title={artifact.title}
                version={{
                  createdAt: preview.createdAt,
                  number: preview.number,
                }}
                viewer="member"
              />
            </Suspense>
          )}
          {interactive ? null : (
            <button
              aria-label={`Interact with ${artifact.title}`}
              className="absolute inset-0 cursor-pointer bg-transparent"
              data-testid="thread-card-overlay"
              onClick={onInteract}
              type="button"
            />
          )}
        </div>
      )}
    </div>
  );
}

/** True once the element has come into view, and stays true. */
function useSeenOnce<Element extends HTMLElement>() {
  const ref = useRef<Element>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return { ref, seen };
}

/**
 * The artifact card of the thread. Desktop opens the version with surface
 * `thread` once the card scrolls into view and shows it live; phones show the
 * thumbnail and never open it.
 */
export function ThreadCard({ artifact }: { artifact: ThreadCardArtifact }) {
  const isMobile = useIsMobile();
  const { ref, seen } = useSeenOnce<HTMLDivElement>();
  const [preview, setPreview] = useState<ThreadCardPreview | null>(null);
  const [interactive, setInteractive] = useState(false);
  const { artifactId, version } = artifact;

  useEffect(() => {
    if (isMobile || !seen) {
      return;
    }
    let current = true;
    getTrpc()
      .artifacts.open.mutate({ artifactId, surface: "thread", version })
      .then((opened) => {
        if (current) {
          setPreview({
            contentUrl: opened.contentUrl,
            createdAt: opened.version.createdAt,
            number: opened.version.number,
            preview: opened.preview === true,
          });
        }
      })
      .catch(() => {
        // The card keeps its skeleton; Open still works.
      });
    return () => {
      current = false;
    };
  }, [artifactId, isMobile, seen, version]);

  const handleInteract = useCallback(() => setInteractive(true), []);
  const handleLeave = useCallback(() => setInteractive(false), []);

  return (
    <div ref={ref}>
      <ThreadCardView
        artifact={artifact}
        interactive={interactive}
        onInteract={handleInteract}
        onLeave={handleLeave}
        preview={preview}
        variant={isMobile ? "phone" : "desktop"}
      />
    </div>
  );
}
