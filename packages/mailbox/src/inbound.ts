// Parts of this file (safeFilename) come from agentic-inbox-hei, workers/index.ts:
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Agentum: the rest of the file is new.

import type { MailboxRef } from "@repo/services/mail/types";
import { extractMessageId } from "./threading.ts";

/**
 * The Worker reads a whole message into memory, so mail above this is rejected
 * until someone measures a 25 MiB message in a Worker.
 */
export const MAIL_MAX_INBOUND_BYTES = 10 * 1024 * 1024;

/** D1 and Durable Object SQLite refuse a value over 2 MB, so bodies are capped. */
export const MAX_BODY_BYTES = 1_000_000;
export const BODY_TRUNCATED_MARKER = "\n\n[Message truncated]";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FORBIDDEN_FILENAME_CHARS = '/\\:*?"<>|';

/** Keeps a file key well under R2's 1,024-byte limit, whatever the sender calls the file. */
const MAX_FILENAME_BYTES = 255;

// UTF-8 continuation bytes are 10xxxxxx, so the range 0x80 to 0xbf.
const isContinuationByte = (byte: number): boolean =>
  byte >= 0x80 && byte <= 0xbf;

/**
 * Caps a body at `maxBytes` UTF-8 bytes, marker included. A cut that lands
 * inside a multi-byte character backs off to the character's first byte.
 */
export const capBody = (
  text: string,
  maxBytes: number = MAX_BODY_BYTES
): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }

  const markerBytes = encoder.encode(BODY_TRUNCATED_MARKER).byteLength;
  let end = maxBytes - markerBytes;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end -= 1;
  }

  return decoder.decode(bytes.subarray(0, end)) + BODY_TRUNCATED_MARKER;
};

/**
 * The key that makes an inbound store idempotent. It is the RFC `Message-ID`
 * when the mail has one, or a SHA-256 of the raw bytes when it has none.
 */
export const dedupeKeyFor = async (input: {
  messageId: string | null;
  raw: Uint8Array;
}): Promise<string> => {
  if (input.messageId !== null) {
    const id = extractMessageId(input.messageId);
    if (id !== "") {
      return id;
    }
  }

  const digest = await crypto.subtle.digest("SHA-256", input.raw.slice());
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
};

/** Makes an attachment name safe to use as one path segment in a file key. */
export const safeFilename = (name: string | null | undefined): string => {
  if (!name) {
    return "untitled";
  }

  const clean = Array.from(name, (char) => {
    const code = char.charCodeAt(0);
    return FORBIDDEN_FILENAME_CHARS.includes(char) || code < 32 || code === 127
      ? "_"
      : char;
  }).join("");
  const bytes = encoder.encode(clean);
  if (bytes.byteLength <= MAX_FILENAME_BYTES) {
    return clean;
  }

  let end = MAX_FILENAME_BYTES;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
};

export const rawMimeKey = (mailbox: MailboxRef, messageId: string): string =>
  `${mailbox.workspaceId}/mail/${mailbox.mailboxId}/raw/${messageId}.eml`;

export const attachmentKey = (
  mailbox: MailboxRef,
  messageId: string,
  attachmentId: string,
  filename: string
): string =>
  `${mailbox.workspaceId}/mail/${mailbox.mailboxId}/${messageId}/${attachmentId}/${filename}`;
