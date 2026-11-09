/** How long the dialog waits before it says what to check. */
export const WAIT_BEFORE_HINT_MS = 60_000;

interface EnrollStatusProps {
  connectedName: string | null;
  elapsedMs: number;
  origin: string;
}

export function EnrollStatus({
  connectedName,
  elapsedMs,
  origin,
}: EnrollStatusProps) {
  if (connectedName !== null) {
    return (
      <p className="font-medium text-sm" role="status">
        Connected: {connectedName}
      </p>
    );
  }
  if (elapsedMs < WAIT_BEFORE_HINT_MS) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Waiting for the machine to connect...
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-sm" role="status">
      Not connected yet. Check that the command finished without an error, that
      the machine can reach {origin}, and that the code has not expired. This
      page keeps checking every few seconds.
    </p>
  );
}
