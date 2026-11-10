import { MACHINE_ENROLL_ROLES, type MachineEnrollRole } from "@repo/db/shared";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
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
  AGENTUM_DESKTOP_SECCOMP_NOTE,
  agentumCommand,
  agentumDockerCommand,
  binaryCommand,
  DESKTOP_SECCOMP_NOTE,
  daemonCommand,
  dockerDesktopCommand,
  dockerHeadlessCommand,
} from "./enroll-commands";
import { EnrollStatus } from "./enroll-status";
import { ENROLL_BUTTON_LABEL, newMachine, ROLE_LABELS } from "./machine-logic";

interface EnrollToken {
  code: string;
  expiresAt: string;
  role: MachineEnrollRole;
}

export const DEFAULT_ENROLL_ROLE: MachineEnrollRole = "both";

/** How often the open dialog asks for the machine list once it shows a code. */
const POLL_MS = 3000;

const DEFAULT_NAME: Record<MachineEnrollRole, string> = {
  agent_host: "my-machine",
  both: "my-machine",
  computer: "my-computer",
};

const ROLE_HINTS: Record<MachineEnrollRole, string> = {
  agent_host: "Claude Code runs agent tasks on this machine.",
  both: "Runs agent tasks and gives agents a computer with one client.",
  computer: "Gives an agent a browser and, on a desktop computer, a screen.",
};

interface EnrollDialogProps {
  /** Ids of the machines that exist now. A machine not in this list is the one being enrolled. */
  knownMachineIds: readonly string[];
  machine?: { id: string; name: string; rust?: boolean };
  onClose: () => void;
  role: MachineEnrollRole;
}

export const RUST_ADD_ROLE_NOTE =
  "Re-enrol this Rust host with a new both-roles code and --replace. Use agentum list to find its instance; use sudo for a system instance. This creates a new machine record: reassign its agents and revoke the old record afterwards.";

export const computerRoleEnrollment = (machine: {
  id: string;
  name: string;
  rust?: boolean;
}) =>
  machine.rust
    ? { machineName: machine.name, role: "both" as const }
    : { machineId: machine.id, role: "computer" as const };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const dialogTitle = (machine: object | undefined): string =>
  machine ? "Add computer role" : ENROLL_BUTTON_LABEL;

const dialogDescription = (
  machine: { name: string; rust?: boolean } | undefined,
  token: EnrollToken | null
): string => {
  if (machine) {
    return machine.rust
      ? RUST_ADD_ROLE_NOTE
      : `Add the computer role to ${machine.name}.`;
  }
  if (token === null) {
    return "Choose a role, name the machine, then create an enrol code for it.";
  }
  return "Run this command to install Agentum, enrol the selected roles and start its service.";
};

interface RoleChoiceProps {
  hint: string;
  label: string;
  onChoose: (role: MachineEnrollRole) => void;
  role: MachineEnrollRole;
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

export function EnrollRoleChoices({
  onChoose,
  selectedRole,
}: {
  onChoose: (role: MachineEnrollRole) => void;
  selectedRole: MachineEnrollRole;
}) {
  return MACHINE_ENROLL_ROLES.map((option) => (
    <RoleChoice
      hint={ROLE_HINTS[option]}
      key={option}
      label={option === "both" ? "Both roles" : ROLE_LABELS[option]}
      onChoose={onChoose}
      role={option}
      selected={selectedRole === option}
    />
  ));
}

export function EnrollDialog({
  role: initialRole,
  knownMachineIds,
  machine,
  onClose,
}: EnrollDialogProps) {
  const [role, setRole] = useState<MachineEnrollRole>(initialRole);
  const [machineName, setMachineName] = useState(DEFAULT_NAME[initialRole]);
  const [nameEdited, setNameEdited] = useState(false);
  const [token, setToken] = useState<EnrollToken | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Adding the computer role to a Go machine changes a machine that already exists.
  const watchesNewMachine = machine === undefined || machine.rust === true;

  useEffect(() => {
    if (token === null || !watchesNewMachine || connectedName !== null) {
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      setElapsedMs(Date.now() - startedAt);
      try {
        const found = newMachine(
          await getTrpc().machines.list.query(),
          knownMachineIds
        );
        if (found !== null) {
          setConnectedName(found.name);
        }
      } catch {
        // A failed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [token, watchesNewMachine, connectedName, knownMachineIds]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const chooseRole = useCallback(
    (next: MachineEnrollRole) => {
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
            ...computerRoleEnrollment(machine),
          })
        : await getTrpc().machines.createEnrollToken.mutate({
            machineName,
            role,
          });
      setToken({
        ...created,
        role: machine ? computerRoleEnrollment(machine).role : role,
      });
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
          <DialogTitle>{dialogTitle(machine)}</DialogTitle>
          <DialogDescription>
            {dialogDescription(machine, token)}
          </DialogDescription>
        </DialogHeader>

        {token ? (
          <div className="flex flex-col gap-4">
            {machine?.rust ? (
              <CommandBlock
                command={`AGENTUM_ENROLL_CODE=${token.code} agentum enroll --instance <instance> --replace\nagentum service restart --instance <instance>`}
                heading="Replace the existing Rust enrolment"
              />
            ) : null}
            {machine === undefined && (
              <>
                <CommandBlock
                  command={agentumCommand(origin, token.code)}
                  heading="Agentum (Linux)"
                />
                <CommandBlock
                  command={agentumDockerCommand(origin, token.code)}
                  heading="Docker, headless"
                />
                <CommandBlock
                  command={agentumDockerCommand(origin, token.code, true)}
                  heading="Docker, with a desktop"
                >
                  <p className="text-muted-foreground text-sm">
                    {AGENTUM_DESKTOP_SECCOMP_NOTE}
                  </p>
                </CommandBlock>
              </>
            )}
            {token.role !== "both" && (
              <details open={machine !== undefined}>
                <summary>Older clients</summary>
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
              </details>
            )}
            {watchesNewMachine ? (
              <EnrollStatus
                connectedName={connectedName}
                elapsedMs={elapsedMs}
                origin={origin}
              />
            ) : null}
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
                <EnrollRoleChoices onChoose={chooseRole} selectedRole={role} />
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
