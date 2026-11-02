import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import {
  canSendInvite,
  DEFAULT_INVITE_ROLE,
  INVITE_ROLE_OPTIONS,
  inviteSentMessage,
} from "./invite-logic.ts";
import { switchErrorMessage } from "./workspace-menu-logic.ts";

/** Asks for an email address and a role, and has the server email an invitation into this workspace. */
export function InviteDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(DEFAULT_INVITE_ROLE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const emailId = useId();
  const roleId = useId();
  const canSend = canSendInvite({ email, pending });

  const handleEmail = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    setSent(null);
  }, []);
  const handleRole = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setRole(event.target.value === "org:admin" ? "org:admin" : "org:member");
    setSent(null);
  }, []);
  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canSend) {
        return;
      }
      setPending(true);
      setError(null);
      setSent(null);
      try {
        await getTrpc().workspaces.invite.mutate({ email, role });
        setSent(inviteSentMessage(email));
        setEmail("");
      } catch (caught) {
        setError(switchErrorMessage(caught));
      } finally {
        setPending(false);
      }
    },
    [canSend, email, role]
  );
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setEmail("");
        setRole(DEFAULT_INVITE_ROLE);
        setError(null);
        setSent(null);
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Invite people</DialogTitle>
            <DialogDescription>
              They get an email with a link that signs them in and opens this
              workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={emailId}>Email address</Label>
            <Input
              autoComplete="off"
              id={emailId}
              onChange={handleEmail}
              type="email"
              value={email}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={roleId}>Role</Label>
            <NativeSelect id={roleId} onChange={handleRole} value={role}>
              {INVITE_ROLE_OPTIONS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          {sent === null ? null : (
            <p className="text-sm" role="status">
              {sent}
            </p>
          )}
          <DialogFooter>
            <Button disabled={!canSend} type="submit">
              {pending ? "Sending" : "Send invitation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
