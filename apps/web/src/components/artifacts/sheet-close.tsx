import { XIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { SheetClose } from "#/components/ui/sheet";

/** The sheet's close button at 40 px, since the built-in one is 28 px (R1.26). Pair it with `showCloseButton={false}`. */
export function SheetCloseButton() {
  return (
    <SheetClose asChild>
      <Button
        className="absolute top-2 right-2 size-10"
        size="icon"
        variant="ghost"
      >
        <XIcon aria-hidden />
        <span className="sr-only">Close</span>
      </Button>
    </SheetClose>
  );
}
