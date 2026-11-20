import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { errorMessage } from "#/lib/error-message";
import { ChangesList } from "./changes-list.tsx";
import { type DreamChangeView, loadDreamChanges } from "./dream-changes.ts";

function OpenChanges({ runId }: { runId: string }): ReactElement {
  const [views, setViews] = useState<DreamChangeView[] | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const result = await loadDreamChanges(runId);
        if (active) {
          setViews(result);
        }
      } catch (error) {
        if (active) {
          setFailure(errorMessage(error));
        }
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [runId]);

  if (failure !== undefined) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {failure}
      </p>
    );
  }
  if (views === undefined) {
    return (
      <p className="text-muted-foreground text-sm">Loading the changes.</p>
    );
  }
  return <ChangesList changes={views} />;
}

export function SeeChanges({ runId }: { runId: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  return (
    <div className="flex flex-col gap-2">
      <Button
        aria-expanded={open}
        onClick={toggle}
        size="sm"
        type="button"
        variant="link"
      >
        {open ? "Hide changes" : "See changes"}
      </Button>
      {open ? <OpenChanges runId={runId} /> : null}
    </div>
  );
}
