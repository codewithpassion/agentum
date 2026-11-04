import type { AppError, ArtifactCall } from "@repo/protocol/artifacts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Button } from "#/components/ui/button";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import { AccessLog } from "./access-log.tsx";
import { errorMessage, formatTimestamp } from "./share-model.ts";

export function CallsTabTrigger({
  kind,
  canManage,
}: {
  kind: string;
  canManage: boolean;
}) {
  return kind === "app" && canManage ? (
    <TabsTrigger className="h-10 md:h-8" value="calls">
      Calls
    </TabsTrigger>
  ) : null;
}

export function RecentErrors({ errors }: { errors: readonly AppError[] }) {
  if (errors.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">Recent errors</h2>
      {errors.map((error) => (
        <div
          className="rounded-md border p-3 text-sm"
          key={`${error.time}:${error.versionId}:${error.entry}:${error.message}`}
        >
          <p className="text-muted-foreground">
            {formatTimestamp(error.time)} · Version {error.version} ·{" "}
            {error.entry}
          </p>
          <p className="whitespace-pre-wrap break-words">{error.message}</p>
          {error.dropped > 0 ? (
            <p className="text-muted-foreground">
              {error.dropped} similar errors dropped
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function CallsTable({ calls }: { calls: readonly ArtifactCall[] }) {
  if (calls.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No calls yet. Requests to this app's endpoints show here.
      </p>
    );
  }
  return (
    <ResponsiveTable>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Endpoint</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Place</TableHead>
          <TableHead>Version</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => (
          <TableRow key={call.id}>
            <ResponsiveCell label="Time">
              {formatTimestamp(call.time)}
            </ResponsiveCell>
            <ResponsiveCell label="Endpoint">{call.endpoint}</ResponsiveCell>
            <ResponsiveCell label="Status">
              {call.statusCode ?? "—"}
            </ResponsiveCell>
            <ResponsiveCell label="Duration">
              {call.durationMs === null ? "—" : `${call.durationMs} ms`}
            </ResponsiveCell>
            <ResponsiveCell label="Place">{call.place ?? "—"}</ResponsiveCell>
            <ResponsiveCell label="Version">
              {call.version ?? "—"}
            </ResponsiveCell>
          </TableRow>
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}

export function Calls({ artifactId }: { artifactId: string }) {
  const [calls, setCalls] = useState<ArtifactCall[]>([]);
  const [errors, setErrors] = useState<AppError[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      request.current += 1;
      const mine = request.current;
      setLoading(true);
      setError(null);
      try {
        const [page, recent] = await Promise.all([
          getTrpc().artifacts.calls.query({
            artifactId,
            ...(cursor === undefined ? {} : { cursor }),
          }),
          getTrpc().artifacts.appErrors.query({ artifactId }),
        ]);
        if (mine !== request.current) {
          return;
        }
        setCalls((current) =>
          cursor === undefined ? page.items : [...current, ...page.items]
        );
        setNext(page.next);
        setErrors(recent);
      } catch (caught) {
        if (mine === request.current) {
          setError(errorMessage(caught));
        }
      } finally {
        if (mine === request.current) {
          setLoading(false);
        }
      }
    },
    [artifactId]
  );
  useEffect(() => {
    setCalls([]);
    setErrors([]);
    setNext(undefined);
    load();
    return () => {
      request.current += 1;
    };
  }, [load]);
  const refresh = useCallback(() => load(), [load]);
  const loadMore = useCallback(() => load(next), [load, next]);
  return (
    <div className="flex flex-col gap-4" data-testid="calls">
      <Button
        className="min-h-10 self-start"
        disabled={loading}
        onClick={refresh}
        variant="outline"
      >
        Refresh
      </Button>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <RecentErrors errors={errors} />
      {loading && calls.length === 0 ? (
        <p className="text-muted-foreground text-sm">Loading</p>
      ) : (
        <CallsTable calls={calls} />
      )}
      {next === undefined ? null : (
        <Button
          className="min-h-10 self-start"
          disabled={loading}
          onClick={loadMore}
          variant="outline"
        >
          Load more
        </Button>
      )}
    </div>
  );
}

export function ArtifactActivity({
  artifactId,
  tab,
  kind,
}: {
  artifactId: string;
  tab: string;
  kind: string;
}) {
  if (tab === "calls" && kind === "app") {
    return <Calls artifactId={artifactId} />;
  }
  return tab === "log" ? <AccessLog artifactId={artifactId} /> : null;
}
