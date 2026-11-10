import { useAuth } from "@clerk/tanstack-react-start";
import { API_KEY_ACCESS, type ApiKeyAccess } from "@repo/db/shared";
import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

const ACCESS_LABELS: Record<ApiKeyAccess, string> = {
  admin: "Admin",
  desk: "Desk",
  read: "Read",
  write: "Write",
};

const parseAccess = (value: string): ApiKeyAccess =>
  API_KEY_ACCESS.find((access) => access === value) ?? "read";

export function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const { orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";
  const accessOptions = API_KEY_ACCESS.filter(
    (option) => option !== "admin" || isAdmin
  );
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ApiKeyAccess>("read");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
    },
    []
  );

  const handleAccessChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setAccess(parseAccess(event.target.value));
    },
    []
  );

  const createKey = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const { secret } = await getTrpc().apiKeys.create.mutate({
        access,
        name,
      });
      onCreated(secret);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }, [access, name, onCreated]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            Read keys can list and read. Write keys can also send messages and
            create or change agents. Desk keys are for another app's desk panel
            and work only on the desk API.
            {isAdmin
              ? " Admin keys can also set up secrets, machines and keys."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-name">Name</Label>
            <Input id="api-key-name" onChange={handleNameChange} value={name} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-access">Access</Label>
            <NativeSelect
              id="api-key-access"
              onChange={handleAccessChange}
              value={access}
            >
              {accessOptions.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {ACCESS_LABELS[option]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <DialogFooter>
            <Button
              disabled={pending || name.trim().length === 0}
              onClick={createKey}
            >
              Create key
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
