// Byte and text helpers shared by the library router and the /library page.
// Plain JS only, so the browser bundle can import it.

/** Files up to this size open in the text view. Larger ones are download only. */
export const LIBRARY_TEXT_MAX_BYTES = 1024 * 1024;

const CHUNK = 0x80_00;
const encoder = new TextEncoder();

export const textToBytes = (text: string): Uint8Array => encoder.encode(text);

/** The text of the bytes, or null when they are too big for the text view or are not UTF-8 text. */
export const decodeLibraryText = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength > LIBRARY_TEXT_MAX_BYTES || bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
