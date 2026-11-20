import type { AgentCard, Team, WorkspaceMember } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { Button } from "#/components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { InboxThread } from "#/integrations/trpc/types";
import { NewTopicDialog } from "./new-topic-dialog.tsx";
import {
  canPostInRoom,
  roomDirectory,
  roomMembers,
  topicsOfTeam,
} from "./room-logic.ts";
import { RoomThread } from "./room-thread.tsx";
import { TopicList } from "./topic-list.tsx";

interface RoomPageProps {
  agents: readonly AgentCard[];
  /** User id to handle, from the people's profiles. */
  handles: ReadonlyMap<string, string>;
  onOpenTopic: (topicId: string) => void;
  people: readonly WorkspaceMember[];
  team: Team;
  threads: readonly InboxThread[];
  topicId: string | undefined;
  userId: string;
}

/** The centre column of a team room: topics on the left, the open topic's posts and its composer. */
export function RoomPage({
  agents,
  handles,
  onOpenTopic,
  people,
  team,
  threads: initialThreads,
  topicId,
  userId,
}: RoomPageProps) {
  const list = usePolledQuery(
    () => getTrpc().inbox.listThreads.query(),
    initialThreads
  );
  const { refresh: refreshThreads } = list;
  const topics = useMemo(
    () => topicsOfTeam(list.data ?? initialThreads, team),
    [list.data, initialThreads, team]
  );
  const directory = useMemo(
    () => roomDirectory({ agents, handles, people }),
    [agents, handles, people]
  );
  const members = useMemo(
    () => roomMembers({ directory, team }),
    [directory, team]
  );
  const canPost = canPostInRoom(team, userId);
  // The topic always includes its creator, so the dialog does not offer them.
  const otherMembers = useMemo(
    () =>
      members.filter(
        (member) => !(member.kind === "user" && member.id === userId)
      ),
    [members, userId]
  );

  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const created = useCallback(
    (thread: InboxThread) => {
      refreshThreads();
      setSheetOpen(false);
      onOpenTopic(thread.id);
    },
    [refreshThreads, onOpenTopic]
  );

  const newTopic = canPost ? (
    <NewTopicDialog
      members={otherMembers}
      onCreated={created}
      teamId={team.id}
    />
  ) : null;
  const topicList = (
    <TopicList
      activeId={topicId}
      onPick={closeSheet}
      teamId={team.id}
      threads={topics}
    />
  );

  return (
    <section className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-4 max-md:hidden">
        <h1 className="font-heading text-3xl text-foreground">{team.name}</h1>
        <p className="text-muted-foreground text-sm">Team room</p>
        {newTopic}
        {list.error === null ? null : (
          <p className="text-destructive text-sm">{list.error}</p>
        )}
        {topicList}
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center justify-between gap-3 md:hidden">
          <h1 className="min-w-0 truncate font-heading text-foreground text-xl">
            {team.name}
          </h1>
          <Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
            <SheetTrigger asChild>
              <Button className="min-h-10" type="button" variant="outline">
                Topics
              </Button>
            </SheetTrigger>
            <SheetContent className="gap-4 overflow-y-auto p-4" side="left">
              <SheetHeader className="p-0">
                <SheetTitle>{`${team.name} topics`}</SheetTitle>
                <SheetDescription className="sr-only">
                  Pick a topic to read.
                </SheetDescription>
              </SheetHeader>
              {newTopic}
              {topicList}
            </SheetContent>
          </Sheet>
        </div>
        <div className="min-w-0">
          {topicId === undefined ? (
            <p className="text-muted-foreground text-sm">
              {canPost
                ? "Pick a topic, or start a new one."
                : "Pick a topic to read."}
            </p>
          ) : (
            <RoomThread
              canPost={canPost}
              directory={directory}
              key={topicId}
              members={members}
              onPosted={refreshThreads}
              team={team}
              threadId={topicId}
              userId={userId}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** The page for a team that is not there. */
export function RoomNotFound() {
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-4">
      <p className="text-muted-foreground text-sm">Team not found.</p>
      <Link className="text-sm underline" to="/agents">
        Back to agents
      </Link>
    </section>
  );
}
