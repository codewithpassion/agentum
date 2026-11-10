import { formatDistanceToNow } from "date-fns";

export const lastFiredLabel = (lastFiredAt: string | null): string =>
  lastFiredAt === null
    ? "never"
    : formatDistanceToNow(new Date(lastFiredAt), { addSuffix: true });
