const KNOWN_KEY =
  /\b(?:sk-(?:ant-)?[\w-]+|ghp_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16}|(?:ag|hm)_[\w-]{8,})\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+|-----BEGIN [A-Z0-9 ]+-----/;
const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const DIGIT = /[0-9]/;
const TOKEN = /[A-Za-z0-9_+/=-]{32,}/g;

/** Ordinary long words have lower entropy than random keys. */
export const containsKey = (text: string): boolean => {
  if (KNOWN_KEY.test(text)) {
    return true;
  }
  for (const match of text.matchAll(TOKEN)) {
    const [token] = match;
    const counts = new Map<string, number>();
    for (const char of token) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / token.length;
      entropy -= p * Math.log2(p);
    }
    const mixed = LOWER.test(token) && UPPER.test(token) && DIGIT.test(token);
    if (
      entropy >= 4.3 ||
      (mixed && entropy >= 4) ||
      (token.length >= 40 && DIGIT.test(token) && entropy >= 3.8)
    ) {
      return true;
    }
  }
  return false;
};
