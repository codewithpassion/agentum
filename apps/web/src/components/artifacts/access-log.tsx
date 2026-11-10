import type { ArtifactShare, ArtifactView } from "@repo/protocol/artifacts";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  describeBrowser,
  describeLink,
  describeNetwork,
  describePlace,
  describeWho,
  OUTCOME_LABELS,
  type OutcomeTone,
  outcomeTone,
} from "./access-log-model.ts";
import { formatTimestamp } from "./share-model.ts";

export interface AccessLogProps {
  artifactId: string;
}

const TONE_VARIANTS: Record<
  OutcomeTone,
  "destructive" | "outline" | "secondary"
> = {
  bad: "destructive",
  ok: "outline",
  warn: "secondary",
};

/** The rows of the log. On phones each row is a stacked card. */
export function AccessLogTable({
  shares,
  views,
}: {
  shares: readonly ArtifactShare[];
  views: readonly ArtifactView[];
}) {
  if (views.length === 0) {
    return <p className="text-muted-foreground text-sm">No opens yet.</p>;
  }
  return (
    <ResponsiveTable>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Who</TableHead>
          <TableHead>Place</TableHead>
          <TableHead>Network</TableHead>
          <TableHead>Browser</TableHead>
          <TableHead>Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {views.map((view) => (
          <TableRow key={view.id}>
            <ResponsiveCell label="Time">
              {formatTimestamp(view.createdAt)}
            </ResponsiveCell>
            <ResponsiveCell label="Who">
              {describeWho(view, shares)}
            </ResponsiveCell>
            <ResponsiveCell label="Place">{describePlace(view)}</ResponsiveCell>
            <ResponsiveCell label="Network">
              {describeNetwork(view)}
            </ResponsiveCell>
            <ResponsiveCell label="Browser">
              {describeBrowser(view.userAgent)}
            </ResponsiveCell>
            <ResponsiveCell label="Outcome">
              <Badge variant={TONE_VARIANTS[outcomeTone(view.outcome)]}>
                {OUTCOME_LABELS[view.outcome]}
              </Badge>
            </ResponsiveCell>
          </TableRow>
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}

/** The access log tab of an artifact: opens by members and links, newest first. */
export function AccessLog({ artifactId }: AccessLogProps) {
  const [shares, setShares] = useState<ArtifactShare[]>([]);
  const [views, setViews] = useState<ArtifactView[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [shareId, setShareId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A reload bumps this, so a slow earlier answer can't overwrite a newer one.
  const request = useRef(0);
  const filterId = useId();

  const load = useCallback(
    async (filter: string, cursor?: string) => {
      request.current += 1;
      const mine = request.current;
      setLoading(true);
      setError(null);
      try {
        const page = await getTrpc().artifacts.views.query({
          artifactId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(filter === "" ? {} : { shareId: filter }),
        });
        if (mine !== request.current) {
          return;
        }
        setViews((current) =>
          cursor === undefined ? page.items : [...current, ...page.items]
        );
        setNext(page.next);
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
    setShareId("");
    setViews([]);
    getTrpc()
      .artifacts.shares.query({ artifactId })
      .then(setShares)
      .catch(() => setShares([]));
    load("");
  }, [artifactId, load]);

  const changeFilter = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setShareId(event.target.value);
      load(event.target.value);
    },
    [load]
  );

  const loadMore = useCallback(
    () => load(shareId, next),
    [load, next, shareId]
  );

  return (
    <div className="flex flex-col gap-4" data-testid="access-log">
      <div className="flex flex-col gap-1 text-sm sm:max-w-sm">
        <label htmlFor={filterId}>Filter by link</label>
        <NativeSelect
          className="w-full max-md:[&_select]:h-10"
          id={filterId}
          onChange={changeFilter}
          value={shareId}
        >
          <NativeSelectOption value="">All opens</NativeSelectOption>
          {shares.map((share) => (
            <NativeSelectOption key={share.id} value={share.id}>
              {describeLink(share)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {loading && views.length === 0 ? (
        <p className="text-muted-foreground text-sm">Loading</p>
      ) : (
        <AccessLogTable shares={shares} views={views} />
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
