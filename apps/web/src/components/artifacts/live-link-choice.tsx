import { useCallback } from "react";
import { type DataMode, LIVE_WARNING, NO_TOOLS_NOTE } from "./live-link-model";

export interface LiveLinkChoiceProps {
  /** Shown next to the warning, for example "This link expires in 7 days.". */
  expiryText: string;
  /** Radio group name, unique per form. */
  groupName: string;
  mode: DataMode;
  onModeChange: (mode: DataMode) => void;
  onToggle: (tool: string) => void;
  options: readonly string[];
  ticked: readonly string[];
}

function ToolCheckbox({
  checked,
  onToggle,
  tool,
}: {
  checked: boolean;
  onToggle: (tool: string) => void;
  tool: string;
}) {
  const onChange = useCallback(() => onToggle(tool), [onToggle, tool]);
  return (
    <label className="flex min-h-10 items-center gap-2 text-sm">
      <input checked={checked} onChange={onChange} type="checkbox" />
      <span className="[overflow-wrap:anywhere]">{tool}</span>
    </label>
  );
}

export function LiveLinkChoice({
  expiryText,
  groupName,
  mode,
  onModeChange,
  onToggle,
  options,
  ticked,
}: LiveLinkChoiceProps) {
  const chooseSnapshot = useCallback(
    () => onModeChange("snapshot"),
    [onModeChange]
  );
  const chooseLive = useCallback(() => onModeChange("live"), [onModeChange]);
  return (
    <fieldset className="space-y-1">
      <legend className="font-medium text-sm">Data</legend>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          checked={mode === "snapshot"}
          name={groupName}
          onChange={chooseSnapshot}
          type="radio"
        />
        Snapshot only
      </label>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          checked={mode === "live"}
          name={groupName}
          onChange={chooseLive}
          type="radio"
        />
        Live, using my connections
      </label>
      {mode === "live" ? (
        <div className="space-y-2 pl-6">
          {options.length === 0 ? (
            <p className="text-muted-foreground text-sm">{NO_TOOLS_NOTE}</p>
          ) : (
            <div>
              {options.map((tool) => (
                <ToolCheckbox
                  checked={ticked.includes(tool)}
                  key={tool}
                  onToggle={onToggle}
                  tool={tool}
                />
              ))}
            </div>
          )}
          <p className="text-sm">
            {LIVE_WARNING} {expiryText}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
