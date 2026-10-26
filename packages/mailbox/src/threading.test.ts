import { describe, expect, test } from "bun:test";
import {
  buildReferencesChain,
  buildThreadingHeaders,
  extractMessageId,
  generateMessageId,
  normalizeSubject,
  resolveThreadId,
  type ThreadReader,
} from "./threading.ts";

const fakeReader = (
  byIds: string | null,
  bySubject: string | null,
  calls: { ids: string[][]; subject: [string, string][] } = {
    ids: [],
    subject: [],
  }
): ThreadReader => ({
  findThreadByIds: (ids) => {
    calls.ids.push(ids);
    return byIds;
  },
  findThreadBySubject: (subject, sender) => {
    calls.subject.push([subject, sender]);
    return bySubject;
  },
});

const UUID_PATTERN = /^[0-9a-f-]{36}$/;

describe("extractMessageId", () => {
  test("returns the text inside angle brackets", () => {
    expect(extractMessageId("<abc@example.com>")).toBe("abc@example.com");
  });

  test("returns the first token when there are no brackets", () => {
    expect(extractMessageId("  abc@example.com  ")).toBe("abc@example.com");
  });

  test("returns the first token and ignores extra text", () => {
    expect(extractMessageId("abc@example.com (note)")).toBe("abc@example.com");
  });

  test("returns an empty string for an empty value", () => {
    expect(extractMessageId("")).toBe("");
    expect(extractMessageId("   ")).toBe("");
  });
});

describe("normalizeSubject", () => {
  test("strips stacked reply and forward prefixes and lowercases", () => {
    expect(normalizeSubject("Re: Fwd: AW: Hello")).toBe("hello");
  });

  test("handles the other prefixes and spacing", () => {
    expect(normalizeSubject("WG :  Sv:Hi")).toBe("hi");
    expect(normalizeSubject("Réf: Offer")).toBe("offer");
  });

  test("leaves a subject without prefixes alone apart from case and trim", () => {
    expect(normalizeSubject("  Meeting Notes ")).toBe("meeting notes");
  });
});

describe("generateMessageId", () => {
  test("builds the rfc id from the new id and the domain", () => {
    expect(generateMessageId("example.com", () => "fixed-id")).toEqual({
      id: "fixed-id",
      rfcMessageId: "fixed-id@example.com",
    });
  });

  test("uses a UUID by default", () => {
    const { id, rfcMessageId } = generateMessageId("example.com");
    expect(id).toMatch(UUID_PATTERN);
    expect(rfcMessageId).toBe(`${id}@example.com`);
  });
});

describe("buildReferencesChain", () => {
  test("keeps the parent last when an older entry names it too", () => {
    const chain = buildReferencesChain({
      emailReferences: JSON.stringify(["c@x", "a@x"]),
      id: "row-1",
      messageId: "c@x",
      threadId: "root@x",
    });
    expect(chain.references).toEqual(["a@x", "c@x"]);
  });

  test("appends the original message id to existing references", () => {
    const chain = buildReferencesChain({
      emailReferences: JSON.stringify(["<a@x>", "b@x"]),
      id: "row-1",
      messageId: "c@x",
      threadId: "root@x",
    });
    expect(chain).toEqual({
      inReplyTo: "c@x",
      references: ["<a@x>", "b@x", "c@x"],
      threadId: "root@x",
    });
  });

  test("treats malformed JSON as empty references", () => {
    const chain = buildReferencesChain({
      emailReferences: "{not json",
      id: "row-1",
      messageId: "c@x",
      threadId: null,
    });
    expect(chain.references).toEqual(["c@x"]);
  });

  test("treats a non-array JSON value as empty references", () => {
    const chain = buildReferencesChain({
      emailReferences: JSON.stringify({ a: 1 }),
      id: "row-1",
      messageId: "c@x",
      threadId: null,
    });
    expect(chain.references).toEqual(["c@x"]);
  });

  test("falls back to the row id when there is no message id", () => {
    const chain = buildReferencesChain({
      emailReferences: null,
      id: "row-1",
      messageId: null,
      threadId: null,
    });
    expect(chain).toEqual({
      inReplyTo: "row-1",
      references: ["row-1"],
      threadId: "row-1",
    });
  });

  test("drops a duplicate tail and keeps the first occurrence", () => {
    const chain = buildReferencesChain({
      emailReferences: JSON.stringify(["a@x", "b@x", "c@x"]),
      id: "row-1",
      messageId: "c@x",
      threadId: "root@x",
    });
    expect(chain.references).toEqual(["a@x", "b@x", "c@x"]);
  });
});

describe("buildThreadingHeaders", () => {
  test("includes References when there are references", () => {
    expect(buildThreadingHeaders("c@x", ["a@x", "c@x"])).toEqual({
      "In-Reply-To": "<c@x>",
      References: "<a@x> <c@x>",
    });
  });

  test("omits References when the list is empty", () => {
    expect(buildThreadingHeaders("c@x", [])).toEqual({
      "In-Reply-To": "<c@x>",
    });
  });
});

describe("resolveThreadId", () => {
  const base = {
    inReplyTo: "reply@x",
    ownId: "own",
    references: ["ref0@x", "ref1@x"],
    sender: "a@example.com",
    subject: "Re: Hello",
  };

  test("step a: an id match wins over a subject match", () => {
    const calls = { ids: [] as string[][], subject: [] as [string, string][] };
    const id = resolveThreadId(
      fakeReader("thread-by-id", "thread-by-subject", calls),
      base
    );
    expect(id).toBe("thread-by-id");
    expect(calls.ids).toEqual([["ref0@x", "ref1@x", "reply@x"]]);
    expect(calls.subject).toEqual([]);
  });

  test("step a: ids are deduplicated before the lookup", () => {
    const calls = { ids: [] as string[][], subject: [] as [string, string][] };
    resolveThreadId(fakeReader("t", null, calls), {
      ...base,
      references: ["reply@x", "ref1@x"],
    });
    expect(calls.ids).toEqual([["reply@x", "ref1@x"]]);
  });

  test("step b: the subject lookup runs when ids match nothing", () => {
    const calls = { ids: [] as string[][], subject: [] as [string, string][] };
    const id = resolveThreadId(
      fakeReader(null, "thread-by-subject", calls),
      base
    );
    expect(id).toBe("thread-by-subject");
    expect(calls.ids).toEqual([["ref0@x", "ref1@x", "reply@x"]]);
    expect(calls.subject).toEqual([["Re: Hello", "a@example.com"]]);
  });

  test("step b: the subject lookup runs when a reply has no ids to match", () => {
    const calls = { ids: [] as string[][], subject: [] as [string, string][] };
    const id = resolveThreadId(fakeReader(null, "thread-by-subject", calls), {
      ...base,
      inReplyTo: null,
      references: [],
    });
    expect(id).toBe("thread-by-subject");
    expect(calls.ids).toEqual([]);
  });

  test("step c: falls to the first reference when nothing matches", () => {
    expect(resolveThreadId(fakeReader(null, null), base)).toBe("ref0@x");
  });

  test("step c: falls to inReplyTo when there are no references", () => {
    expect(
      resolveThreadId(fakeReader(null, null), { ...base, references: [] })
    ).toBe("reply@x");
  });

  test("step d: falls to the own id when there is no thread information", () => {
    expect(
      resolveThreadId(fakeReader(null, null), {
        ...base,
        inReplyTo: null,
        references: [],
      })
    ).toBe("own");
  });

  test("the id lookup is skipped when there are no ids", () => {
    const calls = { ids: [] as string[][], subject: [] as [string, string][] };
    const id = resolveThreadId(fakeReader("never", "by-subject", calls), {
      ...base,
      inReplyTo: null,
      references: [],
    });
    expect(id).toBe("by-subject");
    expect(calls.ids).toEqual([]);
  });
});

describe("extractMessageId with empty brackets", () => {
  test("returns an empty id", () => {
    expect(extractMessageId("<>")).toBe("");
  });
});
