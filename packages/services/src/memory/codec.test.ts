import { expect, test } from "bun:test";
import type { MemoryNote } from "@repo/db/shared";
import {
  apply,
  budget,
  buildIndex,
  MemoryCodecError,
  parseMemoryFile,
  serializeMemoryFile,
} from "./codec.ts";

const ids = [
  "01HZ7KQ3M8V2X4R6T9B1C5D0EF",
  "01HZ8A2N7PW5G3J6D9K4QS1YXM",
  "01HZ9B6R4T8C2V5M1F7H3K0NDP",
] as const;
const note = (overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  date: "2026-11-02",
  id: ids[0],
  kind: "people",
  source: { id: "01HZ5P8Q2W6M4R9T1Y3B7N5C0D", kind: "session" },
  text: "Mia wants drafts as Google Docs, not attachments",
  userScope: null,
  writtenBy: "agent",
  ...overrides,
});
const people = `# People

- id: 01HZ7KQ3M8V2X4R6T9B1C5D0EF
  date: 2026-11-02
  source: session:01HZ5P8Q2W6M4R9T1Y3B7N5C0D
  by: agent
  text: Mia wants drafts as Google Docs, not attachments

- id: 01HZ8A2N7PW5G3J6D9K4QS1YXM
  date: 2026-11-10
  source: none
  by: person
  text: Tom reads reports on his phone, so keep tables short

- id: 01HZ9B6R4T8C2V5M1F7H3K0NDP
  date: 2026-11-14
  source: run:01HZ9B2K6M4W8R1T5Y9C3D7F0G
  by: dream
  text: Priya owns the newsletter list and wants open rates each week
`;
const privateFile = `# Private notes

- id: 01HZA3E8W2Q6R9T4Y7M1B5C8XG
  kind: people
  date: 2026-11-16
  source: session:01HZA1C4N8P2T6W9Y3R7M5D0FE
  by: agent
  text: Anna in Brisbane prefers a call to email when pricing changes

- id: 01HZB7F5K3N9P2D6S8V4H1J0ZR
  kind: work
  date: 2026-11-18
  source: session:01HZB4G7M2Q5W8T1Y6R3N9C0DA
  by: person
  text: Partner brief draft waits on the pricing table from Tally
`;
const parsed = (path: string, text: string) => {
  const result = parseMemoryFile(path, text);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.problems));
  }
  return result.notes;
};
const single = `${people.slice(0, people.indexOf("\n\n- id:", 12))}\n`;

test("format examples round trip byte for byte, including private kinds and empty files", () => {
  for (const [path, text] of [
    ["people.md", people],
    ["private/user_2abc.md", privateFile],
    ["work.md", "# Work\n"],
  ] as const) {
    expect(serializeMemoryFile(path, parsed(path, text))).toBe(text);
  }
  expect(parsed("private/user_2abc.md", privateFile)[1]).toMatchObject({
    kind: "work",
    userScope: "user_2abc",
  });
  expect(
    serializeMemoryFile(
      "people.md",
      parsed("people.md", single.replace("# People", "My title"))
    )
  ).toBe(single);
});

const invalid: [string, string, number][] = [
  ["missing field", single.replace("  date: 2026-11-02\n", ""), 4],
  [
    "wrong order",
    single.replace(
      "  date: 2026-11-02\n  source: session:01HZ5P8Q2W6M4R9T1Y3B7N5C0D",
      "  source: none\n  date: 2026-11-02"
    ),
    4,
  ],
  ["unknown field", single.replace("  by:", "  writer:"), 6],
  ["short id", single.replace(ids[0], "abc"), 3],
  ["non ULID", single.replace(ids[0], "8".repeat(26)), 3],
  ["bad date", single.replace("2026-11-02", "2026-02-30"), 4],
  ["bad date shape", single.replace("2026-11-02", "2026-1-02"), 4],
  [
    "bad source",
    single.replace("session:01HZ5P8Q2W6M4R9T1Y3B7N5C0D", "chat:abc"),
    5,
  ],
  [
    "empty source id",
    single.replace("session:01HZ5P8Q2W6M4R9T1Y3B7N5C0D", "run:"),
    5,
  ],
  ["bad writer", single.replace("by: agent", "by: robot"), 6],
  ["public kind", single.replace("  date:", "  kind: people\n  date:"), 4],
  ["empty text", single.replace(note().text, ""), 7],
  ["long text", single.replace(note().text, "a".repeat(501)), 7],
  ["leading space", single.replace("text: Mia", "text:  Mia"), 7],
  ["trailing space", single.replace("attachments\n", "attachments \n"), 7],
  ["missing separator", people.replace("attachments\n\n", "attachments\n"), 8],
  ["trailing content", `${single}junk\n`, 8],
  ["extra final newline", `${single}\n`, 8],
  ["CRLF", single.replaceAll("\n", "\r\n"), 1],
  ["missing final newline", single.slice(0, -1), 7],
  ["missing title separator", single.replace("# People\n\n", "# People\n"), 2],
];
for (const [label, text, line] of invalid) {
  test(`rejects ${label} atomically with a line number`, () => {
    expect(parseMemoryFile("people.md", text)).toMatchObject({
      ok: false,
      problems: [{ line, message: expect.any(String) }],
    });
    expect(parseMemoryFile("people.md", text)).not.toHaveProperty("notes");
  });
}
test("private kind required and valid; paths and duplicate ids checked", () => {
  expect(parseMemoryFile("private/user_2abc.md", single)).toMatchObject({
    ok: false,
    problems: [{ line: 4 }],
  });
  expect(
    parseMemoryFile(
      "private/user_2abc.md",
      privateFile.replace("kind: people", "kind: other")
    )
  ).toMatchObject({ ok: false, problems: [{ line: 4 }] });
  expect(parseMemoryFile("../people.md", single).ok).toBe(false);
  expect(
    parseMemoryFile(
      "people.md",
      `${single}\n${single.split("\n").slice(2).join("\n")}`
    )
  ).toMatchObject({ ok: false, problems: [{ line: 9 }] });
});
test("colons preserved; writes normalize whitespace before checking length", () => {
  const text = "Trade show list: Queensland done, NSW: waiting";
  expect(
    parsed("people.md", serializeMemoryFile("people.md", [note({ text })]))[0]
      ?.text
  ).toBe(text);
  expect(
    parsed(
      "people.md",
      serializeMemoryFile("people.md", [
        note({ text: ` \n${"x".repeat(500)}\t ` }),
      ])
    )[0]?.text
  ).toHaveLength(500);
  for (const invalidText of [" \n ", "x".repeat(501)]) {
    expect(() =>
      serializeMemoryFile("people.md", [note({ text: invalidText })])
    ).toThrow(MemoryCodecError);
  }
  expect(() => serializeMemoryFile("work.md", [note()])).toThrow();
  expect(() =>
    serializeMemoryFile("people.md", [note({ date: "invalid" })])
  ).toThrow();
});
test("index uses exact sections, cut, date order and later-in-file ties; excludes private", () => {
  const correction = note({
    id: "01HZC2G9T5W1Y8M3Q6R4B7N2XK",
    kind: "corrections",
    text: "Do not email councils on Fridays. Dom said they ignore it. Send them mail on Tuesdays instead.",
  });
  expect(
    buildIndex([
      ...parsed("people.md", people),
      correction,
      ...parsed("private/user_2abc.md", privateFile),
    ])
  ).toBe(`# Memory index

## Corrections (1)

- 01HZC2G9T5W1Y8M3Q6R4B7N2XK: Do not email councils on Fridays. Dom said they ignore it. Send them mail on Tue...

## People (3)

- 01HZ9B6R4T8C2V5M1F7H3K0NDP: Priya owns the newsletter list and wants open rates each week
- 01HZ8A2N7PW5G3J6D9K4QS1YXM: Tom reads reports on his phone, so keep tables short
- 01HZ7KQ3M8V2X4R6T9B1C5D0EF: Mia wants drafts as Google Docs, not attachments
`);
  expect(buildIndex([])).toBe("# Memory index\n");
  expect(buildIndex([note({ text: `${"x".repeat(79)} yz` })])).toContain(
    `${"x".repeat(79)}...\n`
  );
  expect(
    buildIndex([note(), note({ id: ids[1] })]).indexOf(ids[1])
  ).toBeLessThan(buildIndex([note(), note({ id: ids[1] })]).indexOf(ids[0]));
});
test("add appends, preserves input, rebuilds index, and supports private files", () => {
  const files = { "index.md": "stale", "people.md": single };
  const added = note({
    date: "2026-11-20",
    id: ids[1],
    text: "  New\n fact  ",
  });
  const result = apply(files, { action: "add", note: added });
  expect(
    parsed("people.md", result["people.md"] as string).map((n) => n.id)
  ).toEqual([ids[0], ids[1]]);
  expect(result["index.md"] as string).toContain("New fact");
  expect(files["people.md"]).toBe(single);
  const scoped = apply(result, {
    action: "add",
    note: note({ id: ids[2], userScope: "user_2abc" }),
  });
  expect(
    parsed("private/user_2abc.md", scoped["private/user_2abc.md"] as string)
  ).toHaveLength(1);
  expect(scoped["index.md"] as string).not.toContain(ids[2]);
});
test("edit keeps id/source and file position; forget leaves an empty titled file", () => {
  const edited = apply(
    { "people.md": people },
    {
      action: "edit",
      date: "2026-11-20",
      noteId: ids[0],
      text: "Changed",
      writtenBy: "person",
    }
  );
  expect(parsed("people.md", edited["people.md"] as string)[0]).toEqual(
    note({ date: "2026-11-20", text: "Changed", writtenBy: "person" })
  );
  expect((edited["index.md"] as string).split("\n")[4]).toContain(ids[0]);
  expect(
    apply({ "people.md": single }, { action: "forget", noteId: ids[0] })
  ).toEqual({ "index.md": "# Memory index\n", "people.md": "# People\n" });
});
test("merge retains target provenance and scope, removes absorbed notes across files", () => {
  const files = {
    "people.md": single,
    "work.md": serializeMemoryFile("work.md", [
      note({ id: ids[1], kind: "work" }),
    ]),
  };
  const result = apply(files, {
    absorbedIds: [ids[1]],
    action: "merge",
    date: "2026-11-20",
    noteId: ids[0],
    text: "Merged",
    writtenBy: "dream",
  });
  expect(parsed("people.md", result["people.md"] as string)[0]).toEqual(
    note({ date: "2026-11-20", text: "Merged", writtenBy: "dream" })
  );
  expect(result["work.md"] as string).toBe("# Work\n");
  expect(() =>
    apply(files, {
      absorbedIds: [ids[2]],
      action: "merge",
      date: "2026-11-20",
      noteId: ids[0],
      text: "Merged",
      writtenBy: "dream",
    })
  ).toThrow();
});
test("changes reject malformed files, cross-file duplicates, duplicate additions and missing ids atomically", () => {
  const files = { "people.md": single, "work.md": "# Work\n\njunk\n" };
  try {
    apply(files, { action: "forget", noteId: ids[0] });
    throw new Error("expected codec error");
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryCodecError);
    expect(error).toMatchObject({ line: 3, path: "work.md" });
  }
  expect(files["people.md"]).toBe(single);
  expect(() =>
    apply(
      {
        "people.md": single,
        "work.md": serializeMemoryFile("work.md", [note({ kind: "work" })]),
      },
      { action: "forget", noteId: ids[0] }
    )
  ).toThrow(MemoryCodecError);
  expect(() =>
    apply({ "people.md": single }, { action: "add", note: note() })
  ).toThrow(MemoryCodecError);
  expect(() => apply({}, { action: "forget", noteId: ids[0] })).toThrow(
    MemoryCodecError
  );
});
test("budget prioritizes kinds then newest and later ties, never truncates, and skips notes that do not fit", () => {
  const notes = [
    note({ kind: "work", text: "w" }),
    note({ kind: "places", text: "l" }),
    note({ text: "old" }),
    note({ date: "2026-11-20", text: "new" }),
    note({ date: "2026-11-20", text: "tie" }),
    note({ kind: "corrections", text: "fix" }),
  ] as const;
  expect(budget(notes, 100).map((n) => n.text)).toEqual([
    "fix",
    "tie",
    "new",
    "old",
    "l",
    "w",
  ]);
  expect(budget(notes, 4).map((n) => n.text)).toEqual(["fix", "l"]);
  expect(budget(notes, 0)).toEqual([]);
  expect(budget(notes, 3).map((n) => n.text)).toEqual(["fix"]);
  expect(() => budget(notes, -1)).toThrow();
  expect(notes[0].text).toBe("w");
});

test("ULIDs accept either case and cannot duplicate the same id with different casing", () => {
  const lower = single.replace(ids[0], ids[0].toLowerCase());
  expect(parsed("people.md", lower)[0]?.id).toBe(ids[0].toLowerCase());
  expect(serializeMemoryFile("people.md", parsed("people.md", lower))).toBe(
    lower
  );
  expect(() =>
    apply(
      { "people.md": single },
      { action: "add", note: note({ id: ids[0].toLowerCase() }) }
    )
  ).toThrow(MemoryCodecError);
});
