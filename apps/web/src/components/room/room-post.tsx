import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { artifactHref } from "#/components/artifacts/list/artifacts-logic.ts";
import { Markdown } from "#/components/markdown/markdown.tsx";
import { FileChips } from "#/components/thread/file-chips.tsx";
import { buttonVariants } from "#/components/ui/button.tsx";
import type { FileInfo, InboxPost } from "#/integrations/trpc/types.ts";
import { MemberAvatar } from "./member-avatar.tsx";
import { memberKey, type RoomMember } from "./room-types.ts";

const PILL_CLASS = `${buttonVariants({ size: "sm", variant: "outline" })} max-md:min-h-10`;

function AssignedLine({ assigned }: { assigned: readonly RoomMember[] }) {
  return (
    <p className="text-muted-foreground text-xs" data-testid="assigned-to">
      Assigned to{" "}
      {assigned.map((member, index) => (
        <span key={memberKey(member.kind, member.id)}>
          {index === 0 ? null : ", "}
          <span className="font-medium">{member.name}</span>
        </span>
      ))}
    </p>
  );
}

export function RoomPost({
  assigned,
  author,
  authorLabel,
  files,
  post,
}: {
  assigned: readonly RoomMember[];
  author: RoomMember;
  authorLabel: string;
  files: ReadonlyMap<string, FileInfo>;
  post: InboxPost;
}) {
  const hasLinks =
    post.runId !== null || post.artifacts.length > 0 || post.fileIds.length > 0;
  return (
    <li className="flex flex-col gap-2" id={`post-${post.id}`}>
      <div className="flex items-center gap-2">
        <MemberAvatar member={author} />
        <span className="font-medium text-sm">{authorLabel}</span>
        <time
          className="text-muted-foreground text-xs"
          dateTime={post.createdAt}
        >
          {formatDistanceToNow(new Date(post.createdAt), { addSuffix: true })}
        </time>
      </div>
      {post.authorKind === "agent" ? (
        <div className="text-foreground text-sm">
          <Markdown>{post.text}</Markdown>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-foreground text-sm">
          {post.text}
        </p>
      )}
      {assigned.length > 0 ? <AssignedLine assigned={assigned} /> : null}
      {hasLinks ? (
        <ul aria-label="Links" className="flex flex-wrap gap-2">
          {post.runId === null ? null : (
            <li>
              <Link
                className={PILL_CLASS}
                params={{ runId: post.runId }}
                to="/tasks/$runId"
              >
                Task
              </Link>
            </li>
          )}
          {post.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <a className={PILL_CLASS} href={artifactHref(artifact.id)}>
                {artifact.title}
              </a>
            </li>
          ))}
          {post.fileIds.length === 0 ? null : (
            <li>
              <FileChips fileIds={post.fileIds} files={files} />
            </li>
          )}
        </ul>
      ) : null}
    </li>
  );
}
