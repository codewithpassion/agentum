// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Agentum: the send flow lives in port.ts; this file keeps the pure helpers.

import type { OutgoingDraft } from "@repo/services/mail/types";
import { buildThreadingHeaders } from "./threading.ts";

/** A message as the Cloudflare `send_email` binding takes it. */
export interface SendMessage {
  cc?: string[];
  from: string;
  headers?: Record<string, string>;
  html?: string;
  subject: string;
  text?: string;
  to: string[];
}

/** The shape of the Cloudflare `send_email` binding, typed structurally so tests can fake it. */
export interface EmailSender {
  send: (message: SendMessage) => Promise<unknown>;
}

/** Escape all five OWASP-recommended HTML special characters in plain text. */
export const escapeHtml = (text: string): string => {
  if (!text) {
    return "";
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

/** Convert plain text to a simple HTML block with preserved whitespace. */
export const textToHtml = (text: string): string => {
  if (!text) {
    return "";
  }
  const escaped = escapeHtml(text).replace(/\n/g, "<br>");
  return `<div style="white-space:pre-wrap">${escaped}</div>`;
};

/** Strip HTML tags and normalize whitespace to produce plain text. */
export const stripHtmlToText = (html: string): string => {
  if (!html) {
    return "";
  }
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Builds the message the send binding takes from an outgoing draft. It sets no
 * `Message-ID`: Email Sending generates that header and rejects the whole send
 * (`E_HEADER_NOT_ALLOWED`) when a caller supplies one.
 */
export const buildSendMessage = (
  draft: OutgoingDraft,
  reply?: { inReplyTo: string; references: string[] }
): SendMessage => {
  const message: SendMessage = {
    from: draft.from,
    headers: reply
      ? buildThreadingHeaders(reply.inReplyTo, reply.references)
      : {},
    html: draft.html ? draft.html : textToHtml(draft.text),
    subject: draft.subject,
    text: draft.text,
    to: draft.to,
  };
  if (draft.cc.length > 0) {
    message.cc = draft.cc;
  }
  return message;
};

/**
 * Picks the body to store: the text when there is some, else the HTML. Agents
 * read mail as text, and stripping tags from HTML flattens its paragraphs.
 */
export const bodyOf = (
  draft: OutgoingDraft
): { body: string; isHtml: boolean } => {
  if (draft.text) {
    return { body: draft.text, isHtml: false };
  }
  return { body: draft.html ?? "", isHtml: Boolean(draft.html) };
};

/** The domain part of an address, lowercased, or null when there is none. */
export const fromDomain = (address: string): string | null => {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  const domain = normalized.slice(at + 1);
  return domain === "" ? null : domain;
};
