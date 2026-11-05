import { useAuiState } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useThreadEnv } from "./thread-context.tsx";

/** Each run starts at its first message; the viewed older run has a cyan rule. */
export function RunMarker({ children }: { children: ReactNode }) {
  const id = useAuiState((state) => state.message.id);
  const { runMarkers, viewedMessageIds } = useThreadEnv();
  const marker = runMarkers?.get(id);
  return (
    <div
      className={
        viewedMessageIds?.has(id) ? "border-info border-l-2 pl-3" : undefined
      }
    >
      {marker === undefined ? null : (
        <div
          className="mb-4 flex items-center gap-2 text-muted-foreground text-xs before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
          id={`thread-run-${marker.runId}`}
        >
          {marker.label}
        </div>
      )}
      {children}
    </div>
  );
}
