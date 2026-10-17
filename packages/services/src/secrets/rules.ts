/**
 * What a `proxy` secret says: for requests to this host, send this header. A
 * rule is `{ host, header, template }`, and the template holds `{value}` where
 * the secret goes, as in `Bearer {value}`.
 *
 * Host patterns are an exact host or a `*.` wildcard. A wildcard matches a
 * subdomain at any depth and not the domain itself, as Anthropic's vault
 * credentials do, so `*.example.com` matches `api.example.com` and
 * `a.b.example.com` and not `example.com`.
 */
import { z } from "zod";

export const RULES_MAX = 8;
export const TEMPLATE_MAX = 512;
export const VALUE_PLACEHOLDER = "{value}";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Two or more labels, so `localhost` and `*.com` are refused. */
const HOST_PATTERN = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)+${LABEL}$`);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
export const WILDCARD = "*.";
const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7e;
const TRAILING_DOT = /\.$/;

/** Headers the transport owns, or that would let a rule hijack the request. */
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** True when every character is printable ASCII, so the text is a safe header value. */
export const isHeaderSafe = (text: string): boolean =>
  [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= PRINTABLE_ASCII_FIRST && code <= PRINTABLE_ASCII_LAST;
  });

export const ruleSchema = z.strictObject({
  header: z
    .string()
    .trim()
    .regex(HEADER_NAME, "A header name is letters, digits and dashes")
    .refine((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()), {
      message: "That header cannot be set by a rule",
    }),
  host: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      HOST_PATTERN,
      "A host is a domain such as api.example.com, or *.example.com for its subdomains"
    ),
  template: z
    .string()
    .max(TEMPLATE_MAX)
    .refine((text) => text.includes(VALUE_PLACEHOLDER), {
      message: `The header template must contain ${VALUE_PLACEHOLDER}`,
    })
    .refine(isHeaderSafe, {
      message: "The header template may hold printable ASCII only",
    }),
});
export type Rule = z.infer<typeof ruleSchema>;

export const rulesSchema = z.array(ruleSchema).min(1).max(RULES_MAX);

/** The rules as stored: an env secret holds none. */
export const storedRulesSchema = z.array(ruleSchema).max(RULES_MAX);

/** `host` as the request names it, lowercased and without a trailing dot. */
export const normalizeHost = (host: string): string =>
  host.toLowerCase().replace(TRAILING_DOT, "");

/** Whether a request to `host` falls under `pattern`. */
export const matchHost = (pattern: string, host: string): boolean => {
  const target = normalizeHost(host);
  if (!pattern.startsWith(WILDCARD)) {
    return pattern === target;
  }
  const suffix = pattern.slice(1);
  return target.length > suffix.length && target.endsWith(suffix);
};

/** The header value a rule sends for `value`. */
export const renderHeader = (rule: Rule, value: string): string =>
  rule.template.replaceAll(VALUE_PLACEHOLDER, () => value);
