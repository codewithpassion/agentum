import { cn } from "#/lib/utils";

export interface ArtifactFrameProps {
  className?: string;
  contentUrl: string;
  interactive: boolean;
  title: string;
  version: { createdAt: string; number: number };
  viewer: "member" | "link";
}

export function ArtifactFrame({
  className,
  title,
  version,
}: ArtifactFrameProps) {
  return (
    <div
      className={cn("text-muted-foreground text-sm", className)}
      data-testid="artifact-frame"
    >
      {`Artifact frame placeholder: ${title} v${version.number}`}
    </div>
  );
}
