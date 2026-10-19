import { formatDistanceToNow } from "date-fns";

export function keyState(status: {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}): string {
  if (!status.configured || status.hint === null) {
    return "No key set";
  }
  const set = status.updatedAt
    ? formatDistanceToNow(new Date(status.updatedAt), { addSuffix: true })
    : "recently";
  return `Key ending in ${status.hint}, set ${set}`;
}
