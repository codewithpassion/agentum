import { type DragEvent, useCallback } from "react";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query.ts";
import { getTrpc } from "#/integrations/trpc/client";
import {
  buildPalette,
  encodeTool,
  type PaletteItem,
  type PaletteSection,
  TOOL_MIME,
} from "./editor-logic.ts";

const CHIP =
  "cursor-grab rounded-md border border-border px-2 py-1 text-sm select-none";
const LINK = "text-primary text-xs underline-offset-4 hover:underline";

const loadPalette = async (): Promise<PaletteSection[]> => {
  const trpc = getTrpc();
  const [connectors, skills, machines] = await Promise.all([
    trpc.connectors.list.query(),
    trpc.skillStore.list.query(),
    trpc.machines.list.query(),
  ]);
  return buildPalette({ connectors, machines, skills });
};

/** A tool that can be dragged onto an agent. It stays draggable when it needs setup. */
function PaletteChip({ item }: { item: PaletteItem }) {
  const { tool } = item;
  const onDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.dataTransfer.setData(TOOL_MIME, encodeTool(tool));
      event.dataTransfer.effectAllowed = "copy";
    },
    [tool]
  );
  return (
    <div className="flex items-center gap-2">
      <button
        className={CHIP}
        data-testid={`palette-${item.key}`}
        draggable
        onDragStart={onDragStart}
        type="button"
      >
        <span>{item.label}</span>
        {item.detail === "" ? null : (
          <span className="ml-1.5 text-muted-foreground text-xs">
            {item.detail}
          </span>
        )}
      </button>
      {item.setup === null ? null : (
        <a className={LINK} href={item.setup.href}>
          {item.setup.label}
        </a>
      )}
    </div>
  );
}

function PaletteSectionView({ section }: { section: PaletteSection }) {
  const { empty, items, title } = section;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </h3>
      {items.map((item) => (
        <PaletteChip item={item} key={item.key} />
      ))}
      {items.length === 0 && empty !== null ? (
        <p className="text-muted-foreground text-xs">
          {empty.text}{" "}
          <a className={LINK} href={empty.href}>
            {empty.label}
          </a>
        </p>
      ) : null}
    </div>
  );
}

function PaletteBody({
  error,
  sections,
}: {
  error: string | null;
  sections: PaletteSection[] | null;
}) {
  if (sections === null) {
    if (error !== null) {
      return null;
    }
    return <p className="text-muted-foreground text-xs">Loading tools…</p>;
  }
  return sections.map((section) => (
    <PaletteSectionView key={section.title} section={section} />
  ));
}

/** The tools a map editor can drop onto agents, fetched on the desk poll interval. */
export function ToolPalette() {
  const { data, error } = usePolledQuery(
    loadPalette,
    null,
    DESK_POLL_INTERVAL_MS
  );
  return (
    <aside
      aria-label="Tool palette"
      className="min-w-0 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="font-semibold text-sm">Tools</h2>
      <p className="mb-3 text-muted-foreground text-xs">
        Drag a tool onto an agent to plug it in.
      </p>
      {error === null ? null : (
        <p className="mb-2 text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-4">
        <PaletteBody error={error} sections={data} />
      </div>
    </aside>
  );
}
