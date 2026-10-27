import { type ReactNode, useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import type { PaletteItem } from "./editor-logic.ts";
import { ToolPalette } from "./tool-palette.tsx";

/** Shown while a palette tool is picked: the next tap on an agent plugs it in. */
export function PickBanner({
  item,
  onCancel,
}: {
  item: PaletteItem;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-sm"
      data-testid="pick-banner"
    >
      <span>
        Tap an agent to plug in <strong>{item.label}</strong>.
      </span>
      <Button onClick={onCancel} size="sm" type="button" variant="outline">
        Cancel
      </Button>
    </div>
  );
}

/** The column beside the map on a wide screen: the tool palette and the inspector. */
export function SidePanel({
  children = null,
  onPick,
  pickedKey,
  showPalette,
}: {
  children?: ReactNode;
  onPick: (item: PaletteItem | null) => void;
  pickedKey: string | null;
  showPalette: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 lg:min-w-[360px]">
      {showPalette ? (
        <ToolPalette onPick={onPick} pickedKey={pickedKey} />
      ) : null}
      {children}
    </div>
  );
}

/** The inspector as a bottom sheet on a phone, so selecting a node shows it at once. */
export function InspectorSheet({
  children,
  label,
  onClose,
  open,
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
  open: boolean;
}) {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <Sheet onOpenChange={handleOpenChange} open={open}>
      <SheetContent
        className="max-h-[85dvh] overflow-y-auto"
        showCloseButton={false}
        side="bottom"
      >
        <SheetTitle className="sr-only">{label}</SheetTitle>
        <SheetDescription className="sr-only">
          Details and actions for the selected node
        </SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Everything beside the map. On a wide screen it is a column with the palette
 * and the inspector. On a phone the palette stays in the page and the
 * inspector slides up as a sheet.
 */
export function SideArea({
  editor,
  inspector,
  isMobile,
  label,
  onClose,
  onPick,
  pickedKey,
}: {
  editor: boolean;
  inspector: ReactNode;
  isMobile: boolean;
  label: string;
  onClose: () => void;
  onPick: (item: PaletteItem | null) => void;
  pickedKey: string | null;
}) {
  const selected = inspector !== null;
  if (isMobile) {
    return (
      <>
        {editor ? (
          <SidePanel onPick={onPick} pickedKey={pickedKey} showPalette />
        ) : null}
        <InspectorSheet label={label} onClose={onClose} open={selected}>
          {inspector}
        </InspectorSheet>
      </>
    );
  }
  return editor || selected ? (
    <SidePanel onPick={onPick} pickedKey={pickedKey} showPalette={editor}>
      {inspector}
    </SidePanel>
  ) : null;
}
