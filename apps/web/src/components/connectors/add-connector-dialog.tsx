import type { ConnectorAuthMode } from "@repo/db/shared";
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
import type { ConnectorRecord } from "#/integrations/trpc/types";
import { AuthModeSelect } from "./auth-mode-select";
import { type HeaderDraft, HeaderFields } from "./header-fields";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function AddConnectorDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (connector: ConnectorRecord) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [header, setHeader] = useState<HeaderDraft>({
    headerName: "Authorization",
    headerTemplate: "Bearer {value}",
    secretId: null,
  });
  const [authMode, setAuthMode] = useState<ConnectorAuthMode>("auto");
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

  const handleUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setUrl(event.target.value);
    },
    []
  );

  const handleHeaderNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const headerName = event.target.value;
      setHeader((previous) => ({ ...previous, headerName }));
    },
    []
  );

  const createConnector = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const trimmedHeader = header.headerName.trim();
      const connector = await getTrpc().connectors.create.mutate({
        authMode,
        name,
        url,
        ...(authMode === "header"
          ? {
              headerTemplate: header.headerTemplate,
              ...(header.secretId ? { secretId: header.secretId } : {}),
            }
          : {}),
        ...(trimmedHeader === "" ? {} : { headerName: trimmedHeader }),
      });
      onCreated(connector);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }, [authMode, header, name, onCreated, url]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add connector</DialogTitle>
          <DialogDescription>
            A connector is a remote MCP server that agents can call.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connector-name">Name</Label>
            <Input
              id="connector-name"
              onChange={handleNameChange}
              value={name}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connector-url">URL</Label>
            <Input
              id="connector-url"
              onChange={handleUrlChange}
              placeholder="https://mcp.example.com/mcp"
              value={url}
            />
          </div>
          <AuthModeSelect
            id="connector-auth-mode"
            onChange={setAuthMode}
            value={authMode}
          />
          {authMode === "auto" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-header-name">Header name</Label>
              <Input
                id="connector-header-name"
                onChange={handleHeaderNameChange}
                value={header.headerName}
              />
              <p className="text-muted-foreground text-xs">
                Only used when the server asks for a header.
              </p>
            </div>
          )}
          {authMode === "header" && (
            <HeaderFields onChange={setHeader} url={url} value={header} />
          )}
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <DialogFooter>
            <Button
              disabled={
                pending || name.trim().length === 0 || url.trim().length === 0
              }
              onClick={createConnector}
            >
              Add connector
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
