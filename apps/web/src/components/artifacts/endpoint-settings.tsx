import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

interface Endpoint {
  disabledAt: string | null;
  id: string;
  name: string;
  url: string;
}
type Action = "disable" | "enable" | "rotate";

export function EndpointList({
  endpoints,
  busy,
  onCopy,
  onChange,
  copiedUrl = null,
}: {
  copiedUrl?: string | null;
  endpoints: Endpoint[];
  busy: boolean;
  onCopy: (url: string) => void;
  onChange: (id: string, action: Action) => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="font-medium text-sm">Public endpoints</h3>
      {endpoints.length === 0 && (
        <p className="text-muted-foreground text-sm">
          This app has no approved endpoints yet. An endpoint is declared in the
          app's agentum.json and goes live when its version is approved.
        </p>
      )}
      {endpoints.map((endpoint) => (
        <EndpointRow
          busy={busy}
          copied={copiedUrl === endpoint.url}
          endpoint={endpoint}
          key={endpoint.id}
          onChange={onChange}
          onCopy={onCopy}
        />
      ))}
    </section>
  );
}

function EndpointRow({
  endpoint,
  busy,
  copied,
  onCopy,
  onChange,
}: {
  endpoint: Endpoint;
  busy: boolean;
  copied: boolean;
  onCopy: (url: string) => void;
  onChange: (id: string, action: Action) => void;
}) {
  const copy = useCallback(() => onCopy(endpoint.url), [onCopy, endpoint.url]);
  const toggle = useCallback(
    () => onChange(endpoint.id, endpoint.disabledAt ? "enable" : "disable"),
    [onChange, endpoint.id, endpoint.disabledAt]
  );
  const rotate = useCallback(
    () => onChange(endpoint.id, "rotate"),
    [onChange, endpoint.id]
  );
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {endpoint.name}
        {endpoint.disabledAt ? " (disabled)" : ""}
      </p>
      <p className="select-text break-all font-mono text-xs">{endpoint.url}</p>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={copy} size="sm" variant="outline">
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button disabled={busy} onClick={toggle} size="sm" variant="outline">
          {endpoint.disabledAt ? "Enable" : "Disable"}
        </Button>
        <Button disabled={busy} onClick={rotate} size="sm" variant="outline">
          Rotate
        </Button>
      </div>
    </div>
  );
}

/** Shown in the Endpoints tab for app managers. */
export function EndpointSettings({ artifactId }: { artifactId: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const rows = await getTrpc().artifacts.endpoints.query({ artifactId });
    // Previews have no PUBLIC_BASE_URL; resolve their addresses on this origin.
    setEndpoints(
      rows.map((row) => ({
        ...row,
        url: new URL(row.url, window.location.origin).href,
      }))
    );
  }, [artifactId]);
  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);
  const change = useCallback(
    async (id: string, action: Action) => {
      setBusy(true);
      setError(null);
      try {
        await getTrpc().artifacts.changeEndpoint.mutate({ action, id });
        await load();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );
  const copy = useCallback((url: string) => {
    navigator.clipboard
      .writeText(url)
      .then(() => setCopiedUrl(url))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  return (
    <div className="space-y-2">
      <EndpointList
        busy={busy}
        copiedUrl={copiedUrl}
        endpoints={endpoints}
        onChange={change}
        onCopy={copy}
      />
      {error !== null && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
