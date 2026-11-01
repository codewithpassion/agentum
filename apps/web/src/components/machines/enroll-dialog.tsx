import type { MachineRole } from "@repo/db/shared";
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
import { getTrpc } from "#/integrations/trpc/client";
import { CommandBlock } from "./command-block";
import {
  binaryCommand,
  DESKTOP_SECCOMP_NOTE,
  daemonCommand,
  dockerDesktopCommand,
  dockerHeadlessCommand,
} from "./enroll-commands";
import { ROLE_LABELS } from "./machine-logic";

interface EnrollToken {
  code: string;
  expiresAt: string;
  role: MachineRole;
}

const ROLES: MachineRole[] = ["agent_host", "computer"];

const DEFAULT_NAME: Record<MachineRole, string> = {
  agent_host: "my-machine",
  computer: "my-computer",
};

const ROLE_HINTS: Record<MachineRole, string> = {
  agent_host: "Claude Code runs agent tasks on this machine.",
  computer: "Gives an agent a browser and, on a desktop computer, a screen.",
};

interface EnrollDialogProps {
  machine?: { id: string; name: string };
  onClose: () => void;
  role: MachineRole;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const dialogDescription = (
  machine: { name: string } | undefined,
  token: EnrollToken | null
): string => {
  if (machine) {
    return `Add the computer role to ${machine.name}.`;
  }
  if (token === null) {
    return "Choose a role, name the machine, then create an enrol code for it.";
  }
  if (token.role === "computer") {
    return "Run one of these commands on the machine. Each one enrols it with the computer role. The binary command also installs hm-computer.";
  }
  return "Run this command on the machine you want to enrol. It installs the harbourmaster daemon and enrols the machine.";
};

interface RoleChoiceProps {
  hint: string;
  label: string;
  onChoose: (role: MachineRole) => void;
  role: MachineRole;
  selected: boolean;
}

function RoleChoice({
  hint,
  label,
  onChoose,
  role,
  selected,
}: RoleChoiceProps) {
  const choose = useCallback(() => onChoose(role), [onChoose, role]);
  return (
    <div className="flex flex-col gap-1">
      <Button
        aria-pressed={selected}
        onClick={choose}
        variant={selected ? "default" : "outline"}
      >
        {label}
      </Button>
      <p className="text-muted-foreground text-sm">{hint}</p>
    </div>
  );
}

export function EnrollDialog({
  role: initialRole,
  machine,
  onClose,
}: EnrollDialogProps) {
  const [role, setRole] = useState<MachineRole>(initialRole);
  const [machineName, setMachineName] = useState(DEFAULT_NAME[initialRole]);
  const [nameEdited, setNameEdited] = useState(false);
  const [token, setToken] = useState<EnrollToken | null>(null);
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

  const chooseRole = useCallback(
    (next: MachineRole) => {
      setRole(next);
      if (!nameEdited) {
        setMachineName(DEFAULT_NAME[next]);
      }
    },
    [nameEdited]
  );

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setNameEdited(true);
      setMachineName(event.target.value);
    },
    []
  );

  const createCode = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const created = machine
        ? await getTrpc().machines.createEnrollToken.mutate({
            machineId: machine.id,
            role: "computer",
          })
        : await getTrpc().machines.createEnrollToken.mutate({
            machineName,
            role,
          });
      setToken({ ...created, role: machine ? "computer" : role });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [machine, machineName, role]);

  const { origin } = window.location;

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {machine ? "Add computer role" : "Add a machine"}
          </DialogTitle>
          <DialogDescription>
            {dialogDescription(machine, token)}
          </DialogDescription>
        </DialogHeader>

        {token ? (
          <div className="flex flex-col gap-4">
            {token.role === "computer" ? (
              <>
                <CommandBlock
                  command={dockerHeadlessCommand(origin, token.code)}
                  heading="Docker, headless"
                />
                <CommandBlock
                  command={dockerDesktopCommand(origin, token.code)}
                  heading="Docker, with a desktop"
                >
                  <p className="text-muted-foreground text-sm">
                    {DESKTOP_SECCOMP_NOTE}
                  </p>
                </CommandBlock>
                <CommandBlock
                  command={binaryCommand(origin, token.code)}
                  heading="Binary"
                />
              </>
            ) : (
              <CommandBlock command={daemonCommand(origin, token.code)} />
            )}
            <p className="text-muted-foreground text-sm">
              Single use. Expires at{" "}
              {new Date(token.expiresAt).toLocaleTimeString()}.
            </p>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {machine === undefined && (
              <div className="flex flex-col gap-3">
                {ROLES.map((option) => (
                  <RoleChoice
                    hint={ROLE_HINTS[option]}
                    key={option}
                    label={ROLE_LABELS[option]}
                    onChoose={chooseRole}
                    role={option}
                    selected={role === option}
                  />
                ))}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="machine-name">Machine name</Label>
                  <Input
                    id="machine-name"
                    onChange={handleNameChange}
                    value={machineName}
                  />
                </div>
              </div>
            )}
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button disabled={pending} onClick={createCode}>
                Create enrol code
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
