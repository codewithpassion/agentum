/** Pure helpers for the Secrets tab, so the grant rules are testable without React. */

/** The grant set after one secret is switched on or off. Order of the others is kept. */
export const toggledIds = (
  current: readonly string[],
  secretId: string,
  granted: boolean
): string[] => {
  const others = current.filter((id) => id !== secretId);
  return granted ? [...others, secretId] : others;
};

/** The distinct hosts a proxy secret's rules cover, in the order they are first written. */
export const hostsOf = (rules: readonly { host: string }[]): string[] => [
  ...new Set(rules.map((rule) => rule.host)),
];
