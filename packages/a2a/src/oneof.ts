/**
 * Refinement for a proto `oneof`: exactly one of `keys` is present. A key
 * holding `null` counts as present, because `Part.data` may be JSON null.
 */
export const exactlyOneOf =
  (keys: readonly string[]) =>
  (value: object): boolean =>
    keys.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .length === 1;
