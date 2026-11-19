import { Link } from "@tanstack/react-router";
import { splitFolders } from "#/components/agent/profile/library-access.ts";
import { LibraryRow } from "#/components/agent/profile/library-row.tsx";
import { buttonVariants } from "#/components/ui/button.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { RoomSection, TabBody } from "../section.tsx";

/** The room's Files tab: the agent's library access, with a way into its home folder. */
export function FilesTab({ room }: RoomTabProps) {
  const { folders } = room.profile.library;
  const { home } = splitFolders(folders);
  return (
    <TabBody>
      <RoomSection title="Library">
        <LibraryRow agent={room.agent} folders={folders} />
        {home ? (
          <Link
            className={buttonVariants({ variant: "outline" })}
            search={{ dir: home.path }}
            to="/library"
          >
            Open home folder
          </Link>
        ) : null}
      </RoomSection>
    </TabBody>
  );
}
