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
  currentVersionId: string;
  /** Shown in "Pin this version (v{n})" when known. */
  currentVersionNumber?: number;
  onCreated: (share: ArtifactShare) => void;
}

const isExpiryChoice = (value: string): value is ExpiryChoice =>
  (EXPIRY_CHOICES as readonly string[]).includes(value);

export function CreateLinkForm({
  artifactId,
  currentVersionId,
  currentVersionNumber,
  onCreated,
}: CreateLinkFormProps) {
  const id = useId();
  const [expiry, setExpiry] = useState<ExpiryChoice>(DEFAULT_EXPIRY);
  const [date, setDate] = useState("");
  const [pin, setPin] = useState(false);
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
      now: new Date(),
      pin,
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
  }, [artifactId, currentVersionId, date, expiry, onCreated, pin]);

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
      {/* Phase 2: data mode choice (snapshot / live) goes here. */}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button className="min-h-10" disabled={busy} type="submit">
        Create link
      </Button>
    </form>
  );
}
