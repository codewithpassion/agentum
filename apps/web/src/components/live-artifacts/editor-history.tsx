/** biome-ignore-all lint/performance/noJsxPropsBind: Small editor controls capture the command and its current selection. */
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import type { Checkpoint, HistoryPort } from "./editor-ports";
import { ToolButton } from "./editor-toolbar";

export function EditorHistory({
  port,
  editable,
  report,
}: {
  port: HistoryPort;
  editable: boolean;
  report: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<readonly Checkpoint[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (!editable) {
      setConfirm(null);
    }
  }, [editable]);
  const load = async () => {
    setOpen(true);
    setBusy(true);
    try {
      setVersions(await port.list());
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const restore = async (id: string) => {
    if (!editable) {
      return;
    }
    setBusy(true);
    try {
      await port.restore(id);
      setConfirm(null);
      setOpen(false);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    try {
      const result = await port.downloadMarkdown();
      const url = URL.createObjectURL(
        new Blob([result.markdown], { type: "text/markdown;charset=utf-8" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename.replace(/[/\\]/g, "_");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ToolButton disabled={busy} onClick={load}>
        Version history
      </ToolButton>
      <ToolButton disabled={busy} onClick={download}>
        Download markdown
      </ToolButton>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent className="live-history overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Version history</SheetTitle>
            <SheetDescription>
              Restore a checkpoint as a new shared change.
            </SheetDescription>
          </SheetHeader>
          <ToolButton onClick={() => setOpen(false)}>Close history</ToolButton>
          {busy === true && <p role="status">Loading…</p>}
          {!busy && versions.length === 0 && <p>No checkpoints yet.</p>}
          <ul>
            {versions.map((version) => (
              <li key={version.id}>
                <p>{version.label}</p>
                <time dateTime={version.createdAt}>
                  {new Date(version.createdAt).toLocaleString()}
                </time>
                {editable === true && (
                  <ToolButton
                    disabled={busy}
                    onClick={() => setConfirm(version.id)}
                  >
                    Restore {version.label}
                  </ToolButton>
                )}
                {editable && confirm === version.id && (
                  <div>
                    <p>Restore this checkpoint for everyone?</p>
                    <ToolButton
                      disabled={busy}
                      onClick={() => restore(version.id)}
                    >
                      Confirm restore
                    </ToolButton>
                    <ToolButton
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                    >
                      Cancel restore
                    </ToolButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
