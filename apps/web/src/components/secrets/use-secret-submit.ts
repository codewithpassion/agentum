import { useCallback, useState } from "react";
import { errorMessage } from "#/lib/error-message";

/**
 * Runs one save. `run` makes the call and clears any typed value; `onDone`
 * runs after it succeeds. A failure is kept as text for an inline alert.
 */
export function useSecretSubmit(onDone: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (run: () => Promise<void>) => {
      setPending(true);
      setError(null);
      try {
        await run();
        await onDone();
      } catch (caught) {
        setError(errorMessage(caught));
        setPending(false);
      }
    },
    [onDone]
  );

  return { error, pending, submit };
}
