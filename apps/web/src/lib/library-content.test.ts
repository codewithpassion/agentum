import { expect, test } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  decodeLibraryText,
  LIBRARY_TEXT_MAX_BYTES,
  textToBytes,
} from "./library-content.ts";

test("base64 round-trips every byte value, including past one chunk", () => {
  const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
  expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
});

test("text decodes when it is UTF-8 and small", () => {
  expect(decodeLibraryText(textToBytes("héllo\nwörld"))).toBe("héllo\nwörld");
  expect(decodeLibraryText(new Uint8Array())).toBe("");
});

test("bytes that are not text decode to null", () => {
  expect(decodeLibraryText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  expect(decodeLibraryText(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
});

test("text over the limit decodes to null", () => {
  const atLimit = new Uint8Array(LIBRARY_TEXT_MAX_BYTES).fill(97);
  expect(decodeLibraryText(atLimit)?.length).toBe(LIBRARY_TEXT_MAX_BYTES);
  expect(
    decodeLibraryText(new Uint8Array(LIBRARY_TEXT_MAX_BYTES + 1).fill(97))
  ).toBeNull();
});
