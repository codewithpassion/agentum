import { ARTIFACT_KINDS, type ArtifactKind } from "@repo/db/shared";
import { type ChangeEvent, useCallback } from "react";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import {
  type ArtifactFilters,
  KIND_LABELS,
  type MadeBy,
} from "./artifacts-logic.ts";

/** The kind a select value names, or undefined for "" and anything unknown. */
export const parseKind = (value: string): ArtifactKind | undefined =>
  ARTIFACT_KINDS.find((kind) => kind === value);

/** The maker a select value names, or undefined for "" and anything unknown. */
export const parseMadeBy = (value: string): MadeBy | undefined =>
  value === "agent" || value === "person" ? value : undefined;

const SELECT_CLASS = "w-full sm:w-auto [&_select]:h-10";

interface ArtifactsFiltersProps {
  filters: ArtifactFilters;
  onChange: (patch: Partial<ArtifactFilters>) => void;
}

export function ArtifactsFilters({ filters, onChange }: ArtifactsFiltersProps) {
  const handleKindChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange({ kind: parseKind(event.target.value) });
    },
    [onChange]
  );

  const handleMadeByChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange({ madeBy: parseMadeBy(event.target.value) });
    },
    [onChange]
  );

  const handleSharedChange = useCallback(
    (checked: boolean | "indeterminate") => {
      onChange({ shared: checked === true ? true : undefined });
    },
    [onChange]
  );

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto">
        <Label htmlFor="artifacts-kind">Kind</Label>
        <NativeSelect
          className={SELECT_CLASS}
          data-testid="artifacts-filter-kind"
          id="artifacts-kind"
          onChange={handleKindChange}
          value={filters.kind ?? ""}
        >
          <NativeSelectOption value="">All kinds</NativeSelectOption>
          {ARTIFACT_KINDS.map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto">
        <Label htmlFor="artifacts-madeby">Made by</Label>
        <NativeSelect
          className={SELECT_CLASS}
          data-testid="artifacts-filter-madeby"
          id="artifacts-madeby"
          onChange={handleMadeByChange}
          value={filters.madeBy ?? ""}
        >
          <NativeSelectOption value="">Anyone</NativeSelectOption>
          <NativeSelectOption value="agent">Agents</NativeSelectOption>
          <NativeSelectOption value="person">People</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="flex min-h-10 w-full items-center gap-2 sm:w-auto sm:self-end">
        <Checkbox
          checked={filters.shared === true}
          data-testid="artifacts-filter-shared"
          id="artifacts-shared"
          onCheckedChange={handleSharedChange}
        />
        <Label className="max-md:min-h-10" htmlFor="artifacts-shared">
          Shared by link
        </Label>
      </div>
    </div>
  );
}
