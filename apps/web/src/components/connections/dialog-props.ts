/** An agent a person may pick in a connection dialog. */
export interface PickableAgent {
  id: string;
  name: string;
}

/** What the three add dialogs take. The page that opens one owns whether it is open. */
export interface AddDialogProps {
  agents: readonly PickableAgent[];
  /** Runs after a connection or publication changed, so the page can reload. */
  onChanged: () => void;
  /** Closes the dialog. */
  onClose: () => void;
}
