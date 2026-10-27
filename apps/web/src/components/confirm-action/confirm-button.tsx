import type { ComponentProps } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";

/**
 * A button that asks before it acts. `children` is the button label, `title`
 * and `description` fill the dialog (name the item in both), `confirmLabel`
 * defaults to the button label. `onConfirm` runs only after the user agrees.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  description,
  onConfirm,
  title,
  ...buttonProps
}: Omit<ComponentProps<typeof Button>, "onClick" | "title"> & {
  confirmLabel?: string;
  description: string;
  onConfirm: () => void;
  title: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button {...buttonProps}>{children}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            {confirmLabel ?? children}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
