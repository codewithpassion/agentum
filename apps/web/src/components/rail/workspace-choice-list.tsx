import { SignOutButton } from "@clerk/tanstack-react-start";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import type { WorkspaceChoice } from "./workspace-menu-logic.ts";

function ChoiceButton({
  choice,
  onChoose,
}: {
  choice: WorkspaceChoice;
  onChoose: (organizationId: string) => void;
}) {
  const choose = useCallback(() => onChoose(choice.id), [choice.id, onChoose]);
  return (
    <Button
      className="h-auto justify-start whitespace-normal break-words px-3 py-2 text-left"
      onClick={choose}
      type="button"
      variant="outline"
    >
      {choice.name}
    </Button>
  );
}

/**
 * A signed-in person with no workspace open: the workspaces they can switch to,
 * or the way to get one, a failed switch, and `Sign out`. Used by the landing
 * page's no-access state and by `/choose-organization`.
 */
export function WorkspaceChoiceList({
  choices,
  error,
  onChoose,
  subject,
}: {
  choices: WorkspaceChoice[];
  error: string | null;
  onChoose: (organizationId: string) => void;
  /** What has no workspace: an organisation's name, or "This session". */
  subject: string;
}) {
  return (
    <div className="max-w-md space-y-4">
      <p className="font-medium">{subject} has no Agentum workspace.</p>
      {choices.length > 0 ? (
        <>
          <p className="text-muted-foreground text-sm">
            Switch to one of your workspaces, or sign out and use another
            account.
          </p>
          <div className="flex flex-col items-stretch gap-2">
            {choices.map((choice) => (
              <ChoiceButton
                choice={choice}
                key={choice.id}
                onChoose={onChoose}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Ask a workspace admin to invite you, or sign out and use another
          account.
        </p>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <SignOutButton>
        <Button variant="outline">Sign out</Button>
      </SignOutButton>
    </div>
  );
}
