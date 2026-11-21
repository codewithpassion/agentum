import type { ComponentProps } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";

/**
 * A command palette in a dialog. shadcn's `CommandDialog` renders its screen-reader
 * heading outside `DialogContent`, so the heading sits in every page while the dialog
 * is closed. Here the title and description live inside `DialogContent`.
 */
export function FindCommandDialog({
  children,
  description,
  title,
  ...props
}: ComponentProps<typeof Dialog> & { description: string; title: string }) {
  return (
    <Dialog {...props}>
      <DialogContent
        className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
