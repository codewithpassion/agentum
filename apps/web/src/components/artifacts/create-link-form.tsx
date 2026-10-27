import type { ArtifactShare } from "@repo/protocol/artifacts";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import { LiveLinkChoice } from "./live-link-choice";
import { type DataMode, expiryText } from "./live-link-model";
import {
  buildCreateShareInput,
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  EXPIRY_LABELS,
  type ExpiryChoice,
  errorMessage,
} from "./share-model";

export interface CreateLinkFormProps {
  artifactId: string;
  /** Shows the Data choice (snapshot or live) when true. */
  canCreateLive: boolean;
  currentVersionId: string;
  /** Shown in "Pin this version (v{n})" when known. */
  currentVersionNumber?: number;
  /** Approved read-only tools of the version a live link can expose. */
  liveToolOptions: readonly string[];
  onCreated: (share: ArtifactShare) => void;
}

const isExpiryChoice = (value: string): value is ExpiryChoice =>
  (EXPIRY_CHOICES as readonly string[]).includes(value);

export function CreateLinkForm({
  artifactId,
  canCreateLive,
  currentVersionId,
  currentVersionNumber,
  liveToolOptions,
  onCreated,
}: CreateLinkFormProps) {
  const id = useId();
  const [expiry, setExpiry] = useState<ExpiryChoice>(DEFAULT_EXPIRY);
  const [date, setDate] = useState("");
  const [pin, setPin] = useState(false);
  const [mode, setMode] = useState<DataMode>("snapshot");
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pinLabel =
    currentVersionNumber === undefined
      ? "Pin this version"
      : `Pin this version (v${currentVersionNumber})`;

  const submit = useCallback(async () => {
    const built = buildCreateShareInput({
      artifactId,
      currentVersionId,
      date,
      expiry,
      mode: canCreateLive ? mode : "snapshot",
      now: new Date(),
      pin,
      tools: ticked,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const share = await getTrpc().artifacts.createShare.mutate(built.input);
      toast.success("Link created");
      onCreated(share);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    artifactId,
    canCreateLive,
    currentVersionId,
    date,
    expiry,
    mode,
    onCreated,
    pin,
    ticked,
  ]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit]
  );
  const onExpiryChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      if (isExpiryChoice(event.target.value)) {
        setExpiry(event.target.value);
      }
    },
    []
  );
  const onDateChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDate(event.target.value);
  }, []);
  const toggleTool = useCallback((tool: string) => {
    setTicked((current) =>
      current.includes(tool)
        ? current.filter((t) => t !== tool)
        : [...current, tool]
    );
  }, []);
  const followLatest = useCallback(() => setPin(false), []);
  const pinVersion = useCallback(() => setPin(true), []);

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <div className="space-y-1">
        <label className="font-medium text-sm" htmlFor={`${id}-expiry`}>
          Expires
        </label>
        <NativeSelect
          className="w-full max-md:[&_select]:h-10"
          id={`${id}-expiry`}
          onChange={onExpiryChange}
          value={expiry}
        >
          {EXPIRY_CHOICES.map((choice) => (
            <NativeSelectOption key={choice} value={choice}>
              {EXPIRY_LABELS[choice]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {expiry === "date" ? (
        <Input
          aria-label="Expiry date"
          className="min-h-10"
          onChange={onDateChange}
          type="date"
          value={date}
        />
      ) : null}
      <fieldset className="space-y-1">
        <legend className="font-medium text-sm">Version</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            checked={!pin}
            name={`${id}-version`}
            onChange={followLatest}
            type="radio"
          />
          Follow latest version
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            checked={pin}
            name={`${id}-version`}
            onChange={pinVersion}
            type="radio"
          />
          {pinLabel}
        </label>
      </fieldset>
      {canCreateLive ? (
        <LiveLinkChoice
          expiryText={expiryText(expiry, date)}
          groupName={`${id}-data`}
          mode={mode}
          onModeChange={setMode}
          onToggle={toggleTool}
          options={liveToolOptions}
          ticked={ticked}
        />
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button
        className="min-h-10"
        disabled={
          busy ||
          (canCreateLive && mode === "live" && liveToolOptions.length === 0)
        }
        type="submit"
      >
        Create link
      </Button>
    </form>
  );
}
