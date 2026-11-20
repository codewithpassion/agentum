import { useClerk, useUser } from "@clerk/tanstack-react-start";
import { KeyRound, LogOut, UserCog } from "lucide-react";
import { useCallback } from "react";
import { RailLink } from "#/components/rail/rail-link.tsx";
import { Button } from "#/components/ui/button.tsx";

/**
 * The account rows of the phone menu. Clerk's user button opens a popover
 * outside the sheet, where the sheet's focus trap blocks every click, so the
 * phone menu lists the same actions itself and closes first for Clerk's modal.
 */
export function MenuAccount({ onNavigate }: { onNavigate: () => void }) {
  const clerk = useClerk();
  const { user } = useUser();
  const manage = useCallback(() => {
    onNavigate();
    clerk.openUserProfile();
  }, [clerk, onNavigate]);
  const signOut = useCallback(() => {
    onNavigate();
    clerk.signOut({ redirectUrl: "/" });
  }, [clerk, onNavigate]);
  return (
    <div className="mt-2 flex flex-col gap-1 border-border border-t pt-3">
      <p className="truncate px-2 text-muted-foreground text-sm">
        {user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? ""}
      </p>
      <Button
        className="min-h-11 justify-start"
        onClick={manage}
        type="button"
        variant="ghost"
      >
        <UserCog />
        Manage account
      </Button>
      <RailLink
        className="inline-flex min-h-11 items-center gap-2 rounded-md px-2.5 text-sm no-underline hover:bg-muted"
        href="/settings/sign-ins"
        onNavigate={onNavigate}
      >
        <KeyRound className="size-4" />
        Your sign-ins
      </RailLink>
      <Button
        className="min-h-11 justify-start"
        onClick={signOut}
        type="button"
        variant="ghost"
      >
        <LogOut />
        Sign out
      </Button>
    </div>
  );
}
