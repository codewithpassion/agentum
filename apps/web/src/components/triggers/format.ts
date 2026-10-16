import { formatDistanceToNow } from "date-fns";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export const lastFiredLabel = (lastFiredAt: string | null): string =>
  lastFiredAt === null
    ? "never"
    : formatDistanceToNow(new Date(lastFiredAt), { addSuffix: true });
