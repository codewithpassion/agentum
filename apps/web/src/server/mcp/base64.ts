import { ToolError } from "@repo/mcp/result";

/** Bytes per `fromCharCode` call. Spreading a bigger chunk overflows the call stack. */
const CHUNK = 0x80_00;

/**
 * Data characters, then padding. A flat character class, not a repeated group:
 * a repeated group fails on multi-megabyte input. Checked before `atob`, which is lenient.
 */
const BASE64 = /^([A-Za-z0-9+/]*)(={0,2})$/;

/** Padded base64 has four characters per group, so the padding fills the last group. */
const isValidBase64 = (text: string): boolean => {
  const match = BASE64.exec(text);
  if (match === null || text.length % 4 !== 0) {
    return false;
  }
  const data = match[1] ?? "";
  const padding = match[2] ?? "";
  const rest = data.length % 4;
  return rest !== 1 && padding.length === (4 - rest) % 4;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const chunk = bytes.subarray(start, start + CHUNK);
    parts.push(String.fromCharCode(...chunk));
  }
  return btoa(parts.join(""));
};

export const base64ToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const cleaned = text.replace(/\s/g, "");
  if (!isValidBase64(cleaned)) {
    throw new ToolError("validation", "The content is not valid base64.");
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};
