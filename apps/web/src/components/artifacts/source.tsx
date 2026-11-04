import {
  type ArtifactSourceFile,
  type ArtifactsFilesOutput,
  type ArtifactsReadFileOutput,
  isArtifactTextFile,
} from "@repo/protocol/artifacts";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "./share-model.ts";

export function ArtifactTabs({
  canManage,
  value,
  onValueChange,
}: {
  canManage: boolean;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Tabs
      className="shrink-0 border-border border-b px-3"
      onValueChange={onValueChange}
      value={value}
    >
      <TabsList variant="line">
        <TabsTrigger className="h-10 md:h-8" value="artifact">
          Artifact
        </TabsTrigger>
        {canManage ? (
          <TabsTrigger className="h-10 md:h-8" value="log">
            Access log
          </TabsTrigger>
        ) : null}
        <TabsTrigger className="h-10 md:h-8" value="source">
          Source
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export function orderedSourceFiles(
  files: readonly ArtifactSourceFile[],
  entry: string
) {
  const rank = (path: string) => {
    if (path === entry) {
      return 0;
    }
    return path.startsWith("server/") ? 1 : 2;
  };
  return [...files].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path)
  );
}

export function SourceFiles({
  files,
  selected,
  onSelect,
}: {
  files: readonly ArtifactSourceFile[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  const select = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onSelect(event.currentTarget.value);
    },
    [onSelect]
  );
  return (
    <nav
      aria-label="Source files"
      className="flex shrink-0 flex-col gap-1 overflow-auto border-border border-b p-3 md:w-72 md:border-r md:border-b-0"
    >
      {files.map((file) => (
        <Button
          aria-pressed={file.path === selected}
          className="h-auto flex-col items-start whitespace-normal text-left"
          key={file.path}
          onClick={select}
          value={file.path}
          variant={file.path === selected ? "secondary" : "ghost"}
        >
          <span className="break-all font-mono">{file.path}</span>
          <span className="break-all text-muted-foreground text-xs">
            {file.size} bytes · {file.contentType}
          </span>
        </Button>
      ))}
    </nav>
  );
}

export function SourcePreview({
  file,
  read,
}: {
  file: ArtifactSourceFile;
  read?: ArtifactsReadFileOutput | null;
}) {
  if (!isArtifactTextFile(file.contentType)) {
    return (
      <p className="p-3 text-muted-foreground text-sm">
        {file.contentType} · {file.size} bytes. This is a binary file. Download
        has it.
      </p>
    );
  }
  if (!read) {
    return <Spinner />;
  }
  return (
    <div className="min-w-0 flex-1 overflow-auto p-3">
      {read.truncated ? (
        <p className="mb-3 text-muted-foreground text-sm">
          Showing the first 512 KB. The text was cut. Download has the full
          file.
        </p>
      ) : null}
      <pre className="font-mono text-sm">
        {read.text.split("\n").map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are the stable identity in read-only text
          <span data-line={index + 1} key={index}>
            <span
              aria-hidden="true"
              className="mr-4 inline-block w-10 select-none text-right text-muted-foreground"
            >
              {index + 1}
            </span>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Keyed by version by the viewer so a version change always opens its entry. */
export function ArtifactSource({
  artifactId,
  version,
}: {
  artifactId: string;
  version: number;
}) {
  const [listing, setListing] = useState<ArtifactsFilesOutput | null>(null);
  const [selected, setSelected] = useState("");
  const [read, setRead] = useState<ArtifactsReadFileOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTrpc()
      .artifacts.files.query({ artifactId, version })
      .then((result) => {
        if (!cancelled) {
          setListing(result);
          setSelected(result.entry);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, version]);
  const file = listing?.files.find((item) => item.path === selected);
  useEffect(() => {
    let cancelled = false;
    setRead(null);
    setError(null);
    if (file && isArtifactTextFile(file.contentType)) {
      getTrpc()
        .artifacts.readFile.query({ artifactId, path: file.path, version })
        .then((result) => {
          if (!cancelled) {
            setRead(result);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setError(errorMessage(cause));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [artifactId, file, version]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row">
      {listing ? (
        <SourceFiles
          files={orderedSourceFiles(listing.files, listing.entry)}
          onSelect={setSelected}
          selected={selected}
        />
      ) : null}
      {error ? (
        <p className="p-3 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {listing || error ? null : <Spinner />}
      {file && !error ? (
        <SourcePreview
          file={file}
          read={read?.path === selected ? read : null}
        />
      ) : null}
    </div>
  );
}
