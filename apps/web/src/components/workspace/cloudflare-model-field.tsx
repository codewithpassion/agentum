import { useCallback, useId } from "react";
import { TextField } from "#/components/ui/field";
import { CLOUDFLARE_DEFAULT_MODEL_LABEL } from "#/lib/model-format";
import { CLOUDFLARE_MODELS } from "#/modules/runner/models";

/**
 * The model of an agent on the Cloudflare runtime. A free text field rather
 * than a select: the catalog is a set of suggestions, and any Workers AI id
 * or AI Gateway `{provider}/{model}` reference is a valid answer. Empty means
 * the runtime default, which is `null` on the wire like the managed picker.
 */
export function CloudflareModelField({
  onChange,
  value,
}: {
  onChange: (model: string | null) => void;
  value: string | null;
}) {
  const listId = useId();
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange(event.target.value.trim() || null),
    [onChange]
  );

  return (
    <>
      <TextField
        data-testid="agent-cloudflare-model"
        hint={`A Workers AI model (@cf/...) or an AI Gateway {provider}/{model} reference. Leave empty for the ${CLOUDFLARE_DEFAULT_MODEL_LABEL.toLowerCase()}.`}
        label="Model"
        list={listId}
        onChange={change}
        placeholder={CLOUDFLARE_DEFAULT_MODEL_LABEL}
        value={value ?? ""}
      />
      <datalist id={listId}>
        {CLOUDFLARE_MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </datalist>
    </>
  );
}
