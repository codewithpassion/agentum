import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { errorMessage } from "#/lib/error-message";

export interface AppPickerOption {
  disabled: boolean;
  label: string;
  value: string;
}

export interface AppPickerGroup {
  label: string;
  options: AppPickerOption[];
}

/**
 * A menu of apps and the button that adds the chosen one. The caller says what
 * adding does through `onAdd`: a rejection shows under the menu, a resolve
 * clears the choice.
 */
export function AppPicker({
  disabled,
  groups,
  onAdd,
}: {
  /** Turns the menu and the button off. */
  disabled: boolean;
  groups: AppPickerGroup[];
  onAdd: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setValue(event.target.value);
  }, []);

  const add = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await onAdd(value);
      setValue("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [onAdd, value]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="App to add"
          disabled={disabled}
          onChange={handleChange}
          value={value}
        >
          <NativeSelectOption value="">Choose an app</NativeSelectOption>
          {groups.map((group) =>
            group.options.length === 0 ? null : (
              <NativeSelectOptGroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <NativeSelectOption
                    disabled={option.disabled}
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            )
          )}
        </NativeSelect>
        <Button disabled={disabled || value === "" || pending} onClick={add}>
          Add app
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
