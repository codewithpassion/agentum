// Secret masker for the daemon: replaces each provided value with
// `[secret:NAME]` wherever it appears, raw or JSON-encoded, so a secret never
// leaves the machine in a transcript, log line, or completion payload.
//
// A value is carried in two shapes. Its raw text catches plain output. Its
// JSON-encoded text catches a value that a quote, a backslash, or a newline
// has escaped inside a JSON document. Both needles are sorted longest first,
// so a value that contains another value is replaced whole, before the
// shorter one can cut into its replacement.

export interface Masker {
  /** Replaces every needle, raw and JSON-encoded, with `[secret:NAME]`. */
  mask: (text: string) => string;
  /** Same over every string inside an object or array. Never throws. */
  maskDeep: <T>(value: T) => T;
}

interface Needle {
  name: string;
  value: string;
}

const MASKED_PREFIX = "[secret:";
const MASKED_SUFFIX = "]";

const jsonEncode = (value: string): string =>
  JSON.stringify(value).slice(1, -1);

const buildNeedles = (secrets: Readonly<Record<string, string>>): Needle[] => {
  const needles: Needle[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    // An empty needle would match between every character.
    if (value === "") {
      continue;
    }
    needles.push({ name, value });
    const encoded = jsonEncode(value);
    if (encoded !== value) {
      needles.push({ name, value: encoded });
    }
  }
  // Escaping only adds length, so an encoded shape sorts ahead of its raw one.
  return needles.sort((a, b) => b.value.length - a.value.length);
};

export const createMasker = (
  secrets: Readonly<Record<string, string>>
): Masker => {
  const needles = buildNeedles(secrets);

  const mask = (text: string): string => {
    let masked = text;
    for (const { name, value } of needles) {
      masked = masked
        .split(value)
        .join(`${MASKED_PREFIX}${name}${MASKED_SUFFIX}`);
    }
    return masked;
  };

  const maskDeep = <T>(value: T): T => {
    if (typeof value === "string") {
      return mask(value) as T;
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => maskDeep(item)) as T;
    }
    if (typeof value === "object" && value !== null) {
      const masked: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        masked[key] = maskDeep(item);
      }
      return masked as T;
    }
    return value;
  };

  return { mask, maskDeep };
};
