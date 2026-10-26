import { DISPLAY_NAME_LIMIT } from "@repo/services/slack/manifest";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { saveTextFile } from "#/components/slack/download-manifest";
import { ListenModeControl } from "#/components/slack/listen-mode-control";
import { SlackPasteForm } from "#/components/slack/slack-paste-form";
import { errorMessage } from "#/components/triggers/format";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import type { SlackAppRecord } from "#/integrations/trpc/types";
import type { AgentPanelProps } from "./props.ts";

const statusLabels: Record<SlackAppRecord["status"], string> = {
  created: "Created",
  installed: "Installed",
  revoked: "Revoked",
};

function SlackAppRow({
  app,
  onListenModeChanged,
  onRevoke,
}: {
  app: SlackAppRecord;
  onListenModeChanged: () => void;
  onRevoke: (id: string) => void;
}) {
  const appId = app.id;
  const handleRevoke = useCallback(() => onRevoke(appId), [appId, onRevoke]);

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex flex-col gap-1 text-sm">
        <span>Team {app.teamId}</span>
        <span className="text-muted-foreground">App {app.appId}</span>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant={app.status === "installed" ? "default" : "secondary"}>
          {statusLabels[app.status]}
        </Badge>
        {app.status === "installed" && (
          <Button onClick={handleRevoke} size="sm" variant="outline">
            Revoke
          </Button>
        )}
      </div>
      {app.status === "installed" && (
        <ListenModeControl app={app} onChanged={onListenModeChanged} />
      )}
    </li>
  );
}

export function SlackPanel({ agent }: AgentPanelProps) {
  const agentId = agent.id;
  const [apps, setApps] = useState<SlackAppRecord[] | undefined>();
  const [listError, setListError] = useState<string | undefined>();
  const [manifestError, setManifestError] = useState<string | undefined>();
  const [name, setName] = useState(agent.name.slice(0, DISPLAY_NAME_LIMIT));
  const [copied, setCopied] = useState(false);

  const fetchApps = useCallback(
    () => getTrpc().slackApps.list.query({ agentId }),
    [agentId]
  );

  useEffect(() => {
    let active = true;
    fetchApps()
      .then((items) => {
        if (active) {
          setApps(items);
          setListError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setListError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [fetchApps]);

  const reload = useCallback(() => {
    fetchApps()
      .then((items) => {
        setApps(items);
        setListError(undefined);
      })
      .catch((cause: unknown) => setListError(errorMessage(cause)));
  }, [fetchApps]);

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const fetchManifest = useCallback(() => {
    const trimmedName = name.trim();
    return getTrpc().slackApps.manifest.query(
      trimmedName === "" ? { agentId } : { agentId, name: trimmedName }
    );
  }, [agentId, name]);

  const downloadManifest = useCallback(async () => {
    try {
      const manifest = await fetchManifest();
      saveTextFile(manifest.filename, manifest.json);
      setManifestError(undefined);
    } catch (cause) {
      setManifestError(errorMessage(cause));
    }
  }, [fetchManifest]);

  const copyManifest = useCallback(async () => {
    try {
      const manifest = await fetchManifest();
      await navigator.clipboard.writeText(manifest.json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setManifestError(undefined);
    } catch (cause) {
      setManifestError(errorMessage(cause));
    }
  }, [fetchManifest]);

  const revokeApp = useCallback(
    async (id: string) => {
      try {
        await getTrpc().slackApps.revoke.mutate({ id });
      } catch (cause) {
        setListError(errorMessage(cause));
        return;
      }
      reload();
    },
    [reload]
  );

  let list: ReactNode;
  if (apps === undefined) {
    list =
      listError === undefined ? (
        <p className="text-muted-foreground text-sm">Loading Slack apps.</p>
      ) : (
        <p className="text-destructive text-sm">{listError}</p>
      );
  } else {
    list = (
      <>
        {listError !== undefined && (
          <p className="text-destructive text-sm">{listError}</p>
        )}
        {apps.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No Slack app connected yet.
          </p>
        ) : (
          <ul className="divide-y">
            {apps.map((app) => (
              <SlackAppRow
                app={app}
                key={app.id}
                onListenModeChanged={reload}
                onRevoke={revokeApp}
              />
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          Revoking stops the agent answering in Slack and deletes the bot token.
          To remove the app from Slack itself, go to api.slack.com/apps.
        </p>
      </>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-sm">Connect Slack</h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>
            Set the Slack app name if you want a different one, then download or
            copy the manifest.
          </li>
          <li>
            Go to{" "}
            <a
              className="underline"
              href="https://api.slack.com/apps"
              rel="noopener noreferrer"
              target="_blank"
            >
              https://api.slack.com/apps
            </a>
            , choose Create New App, then From a manifest, pick your Slack
            workspace, and paste the manifest JSON.
          </li>
          <li>Install the app to the workspace.</li>
          <li>
            Copy the Signing Secret from Basic Information and the Bot User
            OAuth Token from OAuth &amp; Permissions.
          </li>
          <li>Paste both below.</li>
          <li>Mention the agent in a channel or message it directly.</li>
        </ol>
        <p className="text-muted-foreground text-sm">
          The manifest now turns on interactivity, which the Allow and Deny
          buttons on requests need. If you installed the app before this change,
          paste the new manifest into your Slack app under App Manifest on
          api.slack.com/apps.
        </p>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="slack-app-name">Slack app name</Label>
          <Input
            id="slack-app-name"
            maxLength={DISPLAY_NAME_LIMIT}
            onChange={handleNameChange}
            value={name}
          />
          <p className="text-muted-foreground text-xs">
            {name.length}/{DISPLAY_NAME_LIMIT}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={downloadManifest} variant="outline">
            Download manifest
          </Button>
          <Button onClick={copyManifest} variant="outline">
            {copied ? "Copied" : "Copy manifest"}
          </Button>
        </div>
        {manifestError !== undefined && (
          <p className="text-destructive text-sm">{manifestError}</p>
        )}
        <SlackPasteForm agentId={agentId} onPasted={reload} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">Connected Slack apps</h3>
        {list}
      </div>
    </section>
  );
}
