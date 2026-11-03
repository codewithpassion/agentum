// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Agentum: rewritten without zod or Durable Object stubs, with the thread resolution order of the V5.2 decision.

export interface ThreadReader {
  findThreadByIds: (ids: string[]) => string | null;
  findThreadBySubject: (subject: string, sender: string) => string | null;
}

export interface ThreadResolutionInput {
  inReplyTo: string | null;
  ownId: string;
  references: string[];
  sender: string;
  subject: string;
}

export interface ThreadingOriginal {
  emailReferences: string | null;
  id: string;
  messageId: string | null;
  threadId: string | null;
}

const REPLY_PREFIX = /^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i;
const ANGLED_ID = /<([^>]*)>/;
const WHITESPACE = /\s+/;

const uniqueNonEmpty = (values: string[]): string[] => [
  ...new Set(values.filter((value) => value !== "")),
];

const parseReferences = (raw: string | null): string[] => {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
};

/** Returns the id inside the first `<...>`, else the first token, else "". */
export const extractMessageId = (value: string): string => {
  const match = value.match(ANGLED_ID);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  return value.trim().split(WHITESPACE)[0] ?? "";
};

export const normalizeSubject = (subject: string): string =>
  subject.replace(REPLY_PREFIX, "").trim().toLowerCase();

export const generateMessageId = (
  domain: string,
  newId: () => string = () => crypto.randomUUID()
): { id: string; rfcMessageId: string } => {
  const id = newId();
  return { id, rfcMessageId: `${id}@${domain}` };
};

export const buildReferencesChain = (
  original: ThreadingOriginal
): { inReplyTo: string; references: string[]; threadId: string } => {
  const inReplyTo = original.messageId || original.id;
  // The parent stays last in the chain even when an older entry names it too.
  const references = [
    ...uniqueNonEmpty(parseReferences(original.emailReferences)).filter(
      (id) => id !== inReplyTo
    ),
    inReplyTo,
  ];
  return {
    inReplyTo,
    references,
    threadId: original.threadId || original.id,
  };
};

export const buildThreadingHeaders = (
  inReplyTo: string,
  references: string[]
): Record<string, string> => ({
  "In-Reply-To": `<${inReplyTo}>`,
  ...(references.length > 0
    ? { References: references.map((ref) => `<${ref}>`).join(" ") }
    : {}),
});

export const resolveThreadId = (
  reader: ThreadReader,
  input: ThreadResolutionInput
): string => {
  const ids = uniqueNonEmpty([
    ...input.references,
    ...(input.inReplyTo === null ? [] : [input.inReplyTo]),
  ]);
  if (ids.length > 0) {
    const byIds = reader.findThreadByIds(ids);
    if (byIds) {
      return byIds;
    }
  }

  const bySubject = reader.findThreadBySubject(input.subject, input.sender);
  if (bySubject) {
    return bySubject;
  }

  const [firstReference] = input.references;
  if (firstReference) {
    return firstReference;
  }
  if (input.inReplyTo) {
    return input.inReplyTo;
  }
  return input.ownId;
};
