// The display name of a Client ID Metadata Document (CIMD) client. Such a
// client's OAuth client_id is an https URL with a path, and that URL serves a
// JSON document naming the client. The fetch is bounded: 3 seconds, no
// redirects, and at most 64 KB of body. Any failure gives null.
import { sanitizeOAuthClientName } from "@repo/services/oauth-clients";

const TIMEOUT_MS = 3000;
const MAX_DOCUMENT_BYTES = 65_536;
/** `application/json`, or a `+json` type such as `application/ld+json`. */
const JSON_CONTENT_TYPE = /^\s*application\/(?:[\w.-]+\+)?json\s*(?:;|$)/iu;

const isMetadataClientId = (clientId: string): boolean => {
  const url = new URL(clientId);
  return url.protocol === "https:" && url.pathname !== "/";
};

/** The body as text, or null when it passes the byte cap. */
const readCapped = async (response: Response): Promise<string | null> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_DOCUMENT_BYTES) {
    return null;
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each chunk counts toward the cap before the next read
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
};

/**
 * The `client_name` of the metadata document at `clientId`, or null. Returns
 * null without fetching unless `clientId` is an https URL with a path.
 */
export const cimdClientName =
  (fetchFn: typeof fetch) =>
  async (clientId: string): Promise<string | null> => {
    try {
      if (!isMetadataClientId(clientId)) {
        return null;
      }
      const response = await fetchFn(clientId, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!JSON_CONTENT_TYPE.test(contentType)) {
        return null;
      }
      const text = await readCapped(response);
      if (text === null) {
        return null;
      }
      const document: unknown = JSON.parse(text);
      if (typeof document !== "object" || document === null) {
        return null;
      }
      const { client_id, client_name } = document as Record<string, unknown>;
      if (client_id !== clientId || typeof client_name !== "string") {
        return null;
      }
      return sanitizeOAuthClientName(client_name);
    } catch {
      return null;
    }
  };
