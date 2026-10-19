// Secret masker, shared by the daemon and the services: replaces each provided
// value with `[secret:NAME]` wherever it appears, raw or JSON-encoded, so a
// secret never reaches a transcript, log line, or completion payload.
//
// A value is carried in several shapes. Its raw text catches plain output. Its
// JSON-encoded text catches a value that a quote, a backslash, or a newline
// has escaped inside a JSON document. Its standard base64 (of the UTF-8 bytes,
// padded) catches a value a tool wrote in base64, such as an HTTP Basic
// header. Its URL-encoded text, and the form-encoded variant that writes a
// space as `+`, catches a value that went into a query string or a form body.
// A shape is kept only when it differs from the shapes already kept for the
// same value. All needles are sorted longest first, so a value that contains
// another value is replaced whole, before the shorter one can cut into its
// replacement.

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
const PERCENT_SPACE = "%20";
const FORM_SPACE = "+";

const jsonEncode = (value: string): string =>
  JSON.stringify(value).slice(1, -1);

const base64Encode = (value: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const formEncode = (value: string): string =>
  encodeURIComponent(value).replaceAll(PERCENT_SPACE, FORM_SPACE);

// Every shape of one value, raw first. The Set drops a shape that repeats an
// earlier one, so an unchanged shape adds no needle.
const shapesOf = (value: string): string[] => [
  ...new Set([
    value,
    jsonEncode(value),
    base64Encode(value),
    encodeURIComponent(value),
    formEncode(value),
  ]),
];

const buildNeedles = (secrets: Readonly<Record<string, string>>): Needle[] => {
  const needles: Needle[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    // An empty needle would match between every character.
    if (value === "") {
      continue;
    }
    for (const shape of shapesOf(value)) {
      needles.push({ name, value: shape });
    }
  }
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
