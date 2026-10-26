import type { z } from "zod";

type JsonValue = z.infer<ReturnType<typeof z.json>>;
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "auth",
  "authtoken",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apitoken",
  "apikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "cookie",
  "setcookie",
  "signature",
  "privatekey",
  "credential",
  "credentials",
  "bearer",
]);
const SECRET_KEY_SUFFIX =
  /(?:token|secret|password|apikey|signature|privatekey)\d*$/;
const URL_SECRET_KEY_SUFFIX =
  /(?:token|auth|sig|signature|key|secret|password|credential|credentials)\d*$/;
const KEY_SEPARATORS = /[-_]/g;
const SECRET_VALUE =
  /^(?:(?:bearer|basic|token)\s+\S+|(?:authorization|cookie):\s*\S+)$/i;
const HARBOURMASTER_TOKEN =
  /^hm_[a-z]+_[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,})?$/;
const API_TOKEN = /^sk-[A-Za-z0-9_-]{16,}$/;
const HTTP_SCHEME = /^\s*https?:/i;
const URL_WHITESPACE = /[\t\r\n]/;
const URL_WHITESPACE_GLOBAL = /[\t\r\n]/g;
const URL_USERINFO =
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{0,256}@/gi;

export function sanitizeUrl(value: string): string {
  if (
    !(
      HTTP_SCHEME.test(value) ||
      (URL_WHITESPACE.test(value) &&
        HTTP_SCHEME.test(value.replace(URL_WHITESPACE_GLOBAL, "")))
    )
  ) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return value;
    }
    let changed = false;
    const filter = (params: URLSearchParams) => {
      const kept = new URLSearchParams();
      for (const [key, item] of params) {
        const normalized = key.toLowerCase().replace(KEY_SEPARATORS, "");
        if (
          SECRET_KEYS.has(normalized) ||
          URL_SECRET_KEY_SUFFIX.test(normalized) ||
          normalized === "code" ||
          normalized === "jwt"
        ) {
          changed = true;
        } else {
          kept.append(key, item);
        }
      }
      return kept.toString();
    };
    const query = filter(url.searchParams);
    const queryChanged = changed;
    changed = false;
    const hash = url.hash.slice(1);
    const question = hash.indexOf("?");
    const route = question < 0 ? "" : hash.slice(0, question + 1);
    const fragment = filter(
      new URLSearchParams(question < 0 ? hash : hash.slice(question + 1))
    );
    if (queryChanged) {
      url.search = query;
    }
    if (changed) {
      url.hash = route + fragment;
    }
    return changed || queryChanged ? url.toString() : value;
  } catch {
    return value;
  }
}

export function stripSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const normalized = key.toLowerCase().replace(KEY_SEPARATORS, "");
        return [
          key,
          SECRET_KEYS.has(normalized) || SECRET_KEY_SUFFIX.test(normalized)
            ? "[redacted]"
            : stripSecrets(item),
        ];
      })
    );
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      SECRET_VALUE.test(trimmed) ||
      HARBOURMASTER_TOKEN.test(trimmed) ||
      API_TOKEN.test(trimmed)
    ) {
      return "[redacted]";
    }
    const sanitized = sanitizeUrl(value);
    return sanitized.includes("://") && sanitized.includes("@")
      ? sanitized.replace(URL_USERINFO, "$1[redacted]@")
      : sanitized;
  }
  return value;
}
