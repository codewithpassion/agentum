import { RailLink } from "#/components/rail/rail-link.tsx";

const LINK_CLASS =
  "inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

/** A link to the team's room. The room route is not in the typed route tree yet, so this uses a plain path. */
export function RoomLink({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  return (
    <RailLink
      className={LINK_CLASS}
      href={`/teams/${encodeURIComponent(teamId)}/room`}
      label={`Open room for ${teamName}`}
    >
      Open room
    </RailLink>
  );
}
