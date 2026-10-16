import { formatDistanceToNow } from "date-fns";
import { authorLabel } from "#/components/inbox/inbox-logic";
import type { InboxPost } from "#/integrations/trpc/types";

interface PostListProps {
  agentNames: ReadonlyMap<string, string>;
  posts: readonly InboxPost[];
  userId: string;
}

export function PostList({ agentNames, posts, userId }: PostListProps) {
  if (posts.length === 0) {
    return <p className="text-muted-foreground text-sm">No posts yet.</p>;
  }
  return (
    <ol aria-label="Posts" className="flex flex-col gap-4">
      {posts.map((post) => (
        <li className="flex flex-col gap-1" key={post.id}>
          <p className="text-sm">
            <span className="font-medium">
              {authorLabel(post, userId, agentNames)}
            </span>{" "}
            <time
              className="text-muted-foreground text-xs"
              dateTime={post.createdAt}
            >
              {formatDistanceToNow(new Date(post.createdAt), {
                addSuffix: true,
              })}
            </time>
          </p>
          <p className="whitespace-pre-wrap text-foreground text-sm">
            {post.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
