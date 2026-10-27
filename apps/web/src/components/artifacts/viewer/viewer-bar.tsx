import type { ArtifactDetail, ArtifactVersion } from "@repo/protocol/artifacts";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Share2 } from "lucide-react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useCallback, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import {
  byline,
  canPromote,
  downloadPath,
  type PromoteState,
  promoteButton,
  versionOptionLabel,
  versionStatusBadge,
} from "./viewer-logic.ts";
import { type PinSurface, pinMenuLabel } from "./viewer-menu-model.ts";

// Menu rows are 40 px tall on phones (R1.26).
const ITEM_CLASS = "min-h-10 md:min-h-0";

interface TitleProps {
  canRename: boolean;
  onRename: (title: string) => void;
  title: string;
}

function Title({ canRename, onRename, title }: TitleProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const startEditing = useCallback(() => setDraft(title), [title]);
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const commit = useCallback(() => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== title) {
      onRename(next);
    }
  }, [draft, onRename, title]);
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        commit();
      } else if (event.key === "Escape") {
        setDraft(null);
      }
    },
    [commit]
  );

  if (draft !== null) {
    return (
      <Input
        aria-label="Title"
        autoFocus
        className="h-10 max-w-xs md:h-8"
        maxLength={120}
        onBlur={commit}
        onChange={change}
        onKeyDown={keyDown}
        value={draft}
      />
    );
  }
  return (
    <h1 className="min-w-0 truncate font-medium text-sm">
      {canRename ? (
        <button
          className="max-w-full truncate text-left hover:underline max-md:min-h-10"
          onClick={startEditing}
          title="Rename"
          type="button"
        >
          {title}
        </button>
      ) : (
        title
      )}
    </h1>
  );
}

interface ViewerBarProps {
  detail: ArtifactDetail;
  onAudience: (audience: "private" | "workspace") => void;
  onCopyLink: () => void;
  onDelete: () => void;
  onFullScreen: () => void;
  onHandTo: () => void;
  onHistory: () => void;
  onPromote: () => void;
  onRename: (title: string) => void;
  onShare: () => void;
  onTogglePin: (surface: PinSurface) => void;
  onVersion: (version: number) => void;
  pinned: ReadonlySet<PinSurface>;
  promoteState: PromoteState;
  shownNumber: number;
  versions: readonly ArtifactVersion[];
}

export function ViewerBar({
  detail,
  onAudience,
  onCopyLink,
  onDelete,
  onFullScreen,
  onHandTo,
  onHistory,
  onPromote,
  onRename,
  onShare,
  onTogglePin,
  onVersion,
  pinned,
  promoteState,
  shownNumber,
  versions,
}: ViewerBarProps) {
  const parts = byline(detail);
  const taskJoiner = parts.agent ? " in " : " · made in ";
  const sorted = [...versions].sort((a, b) => b.number - a.number);
  const changeVersion = useCallback(
    (value: string) => onVersion(Number(value)),
    [onVersion]
  );
  const shown = sorted.find((version) => version.number === shownNumber);
  const badge = shown ? versionStatusBadge(shown.status) : null;
  const promote = promoteButton(promoteState);
  const pinSidebar = useCallback(() => onTogglePin("sidebar"), [onTogglePin]);
  const pinDesk = useCallback(() => onTogglePin("desk"), [onTogglePin]);
  const changeAudience = useCallback(
    (value: string) =>
      onAudience(value === "private" ? "private" : "workspace"),
    [onAudience]
  );

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-border border-b bg-background px-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Title
          canRename={detail.canManage}
          onRename={onRename}
          title={detail.title}
        />
        <p className="hidden min-w-0 truncate text-muted-foreground text-xs md:block">
          by {parts.owner}
          {parts.agent ? ` · made by ${parts.agent}` : ""}
          {parts.task ? taskJoiner : ""}
          {parts.task ? (
            <Link
              className="underline"
              params={{ runId: parts.task.runId }}
              to="/tasks/$runId"
            >
              {parts.task.title ?? "a task"}
            </Link>
          ) : null}
        </p>
      </div>
      <div className="hidden md:block">
        <Select onValueChange={changeVersion} value={String(shownNumber)}>
          <SelectTrigger aria-label="Version" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((version) => (
              <SelectItem key={version.id} value={String(version.number)}>
                {versionOptionLabel(version)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {badge ? <Badge variant="secondary">{badge}</Badge> : null}
      {canPromote(detail, shown) ? (
        <>
          {promoteState === "waiting" ? (
            <Link
              className="hidden text-muted-foreground text-xs underline md:inline"
              to="/desk"
            >
              Decide the grants in Needs you
            </Link>
          ) : null}
          <Button
            className="h-10 md:h-8"
            disabled={promote.disabled}
            onClick={onPromote}
            size="sm"
            variant={promoteState === "idle" ? "default" : "outline"}
          >
            {promote.label}
          </Button>
        </>
      ) : null}
      {detail.canManage ? (
        <Button className="h-10 md:h-8" onClick={onShare} size="sm">
          <Share2 />
          Share
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More"
            className="size-10 md:size-8"
            size="icon"
            variant="ghost"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className={ITEM_CLASS} onSelect={onFullScreen}>
            Open full screen
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM_CLASS} onSelect={onHistory}>
            Version history
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM_CLASS} onSelect={onCopyLink}>
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={ITEM_CLASS}>
            <a download href={downloadPath(detail.artifactId, shownNumber)}>
              Download
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={ITEM_CLASS} onSelect={pinSidebar}>
            {pinMenuLabel("sidebar", pinned.has("sidebar"))}
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM_CLASS} onSelect={pinDesk}>
            {pinMenuLabel("desk", pinned.has("desk"))}
          </DropdownMenuItem>
          {detail.canManage ? (
            <>
              <DropdownMenuItem className={ITEM_CLASS} onSelect={onHandTo}>
                Hand to agent...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Audience</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={changeAudience}
                value={detail.audience}
              >
                <DropdownMenuRadioItem className={ITEM_CLASS} value="private">
                  Private
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem className={ITEM_CLASS} value="workspace">
                  Workspace
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={ITEM_CLASS}
                onSelect={onDelete}
                variant="destructive"
              >
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
