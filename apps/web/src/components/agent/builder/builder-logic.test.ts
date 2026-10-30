import { describe, expect, test } from "bun:test";
import type {
  AgentDraft,
  BuilderCatalog,
} from "@repo/services/agent-builder/draft";
import {
  addressSuggestion,
  applyEdit,
  builderSteps,
  clearDescription,
  DESCRIPTION_KEY,
  decideText,
  importFileError,
  importTextError,
  isLocked,
  isNoKeyError,
  loadDescription,
  MAX_IMPORT_BYTES,
  openGaps,
  redraftBlocker,
  rulesOf,
  runsOnOptions,
  saveDescription,
  toggleId,
  toggleStart,
} from "./builder-logic.ts";

const fakeStorage = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    items,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};

const brokenStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

const draft: AgentDraft = {
  does: "Sorts the inbox.",
  handsTo: [],
  library: [],
  name: "Sorter",
  rules: [],
  runsOn: null,
  sampleInput: [],
  skills: [],
  startsOn: [],
  tools: [],
  voice: "brief",
};

describe("locked fields", () => {
  test("an edit changes the draft and locks only that field", () => {
    const next = applyEdit(draft, {}, { name: "Mail sorter" });
    expect(next.draft.name).toBe("Mail sorter");
    expect(next.locked).toEqual({ name: "Mail sorter" });
    expect(draft.name).toBe("Sorter");
  });

  test("later edits keep earlier locks", () => {
    const first = applyEdit(draft, {}, { name: "Mail sorter" });
    const second = applyEdit(first.draft, first.locked, { rules: ["No spam"] });
    expect(second.locked).toEqual({ name: "Mail sorter", rules: ["No spam"] });
    expect(isLocked(second.locked, "rules")).toBe(true);
    expect(isLocked(second.locked, "does")).toBe(false);
  });

  test("an empty list is still a lock", () => {
    const next = applyEdit(draft, {}, { tools: [] });
    expect(isLocked(next.locked, "tools")).toBe(true);
  });
});

describe("redraftBlocker", () => {
  test("a named draft with a does can go back", () => {
    expect(redraftBlocker(draft)).toBeNull();
  });

  test("a blank name or does blocks the redraft", () => {
    expect(redraftBlocker({ ...draft, name: "  " })).toContain("Name");
    expect(redraftBlocker({ ...draft, does: "" })).toContain("what the agent");
  });
});

describe("gap counting", () => {
  const gaps = [
    { field: "runs_on", question: "Where it runs" },
    { field: "tools", question: "No connector for x yet" },
  ] as const;

  test("untouched gaps stay open", () => {
    expect(openGaps(gaps, draft, {})).toHaveLength(2);
  });

  test("editing a field settles its gap", () => {
    expect(openGaps(gaps, draft, { tools: [] })).toEqual([gaps[0]]);
  });

  test("a runtime gap needs a chosen runtime", () => {
    expect(openGaps(gaps, draft, { runsOn: null })).toHaveLength(2);
    const chosen = { ...draft, runsOn: { runtime: "cloud" } } as const;
    expect(openGaps(gaps, chosen, { runsOn: chosen.runsOn })).toEqual([
      gaps[1],
    ]);
  });

  test("the count reads in words", () => {
    expect(decideText(0)).toBeNull();
    expect(decideText(1)).toBe("1 thing to decide");
    expect(decideText(3)).toBe("3 things to decide");
  });

  test("steps list what was done, then what waits", () => {
    expect(builderSteps(["Named it Sorter"], [gaps[0]])).toEqual([
      { done: true, label: "Named it Sorter" },
      { done: false, label: "Waiting for you: Where it runs" },
    ]);
  });
});

describe("file import limits", () => {
  test("accepts .md and .txt up to 200 KB", () => {
    expect(importFileError({ name: "brief.md", size: 10 })).toBeNull();
    expect(importFileError({ name: "NOTES.TXT", size: 10 })).toBeNull();
    expect(
      importFileError({ name: "big.txt", size: MAX_IMPORT_BYTES })
    ).toBeNull();
  });

  test("refuses a file over 200 KB", () => {
    expect(
      importFileError({ name: "big.txt", size: MAX_IMPORT_BYTES + 1 })
    ).toBe("That file is over 200 KB.");
  });

  test("refuses anything that is not text", () => {
    expect(importFileError({ name: "photo.png", size: 10 })).toBe(
      "Import a .md or .txt file."
    );
    expect(importFileError({ name: "notes", size: 10 })).not.toBeNull();
  });

  test("refuses empty text and text past the description limit", () => {
    expect(importTextError("  \n")).toBe("That file is empty.");
    expect(importTextError("a".repeat(8001))).toContain("8000");
    expect(importTextError("a".repeat(8000))).toBeNull();
  });
});

describe("list edits", () => {
  test("rulesOf keeps one rule per non-blank line", () => {
    expect(rulesOf(" Never pay \r\n\n Cite sources ")).toEqual([
      "Never pay",
      "Cite sources",
    ]);
  });

  test("toggleId adds then removes", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });

  test("toggleStart keeps routines", () => {
    const routine = {
      cron: "0 9 1 * *",
      kind: "routine",
      label: "Monthly",
      prompt: "Monthly",
    } as const;
    const on = toggleStart([routine], "mail");
    expect(on).toEqual([routine, { kind: "mail" }]);
    expect(toggleStart(on, "mail")).toEqual([routine]);
  });

  test("addressSuggestion turns a name into an address", () => {
    expect(addressSuggestion("  Mail Sorter!  ")).toBe("mail-sorter");
    expect(addressSuggestion("!!")).toBe("");
    expect(addressSuggestion("a".repeat(60))).toHaveLength(40);
  });
});

describe("runsOnOptions", () => {
  const catalog: BuilderCatalog = {
    agents: [],
    connectors: [],
    machines: [
      { id: "m1", name: "studio-nuc", online: true },
      { id: "m2", name: "laptop", online: false },
    ],
    runtimes: ["machine", "cloud"],
    skills: [],
  };

  test("lists usable runtimes and every machine", () => {
    expect(runsOnOptions(catalog, null).map((o) => o.label)).toEqual([
      "Cloudflare",
      "studio-nuc",
      "laptop",
    ]);
  });

  test("marks the chosen option and the offline machine", () => {
    const options = runsOnOptions(catalog, {
      machineId: "m2",
      runtime: "machine",
    });
    expect(options.filter((o) => o.selected).map((o) => o.key)).toEqual([
      "machine:m2",
    ]);
    expect(options.at(-1)?.note).toBe("offline");
  });

  test("offers no machines when the machine runtime is unavailable", () => {
    expect(
      runsOnOptions({ ...catalog, runtimes: ["managed"] }, null)
    ).toHaveLength(1);
  });
});

describe("no-key error", () => {
  test.each([
    [
      "This workspace has no Anthropic API key. Add one in Settings, Anthropic API key.",
      true,
    ],
    ["Error: This workspace has no Anthropic API key.", true],
    ["The Anthropic API key was rejected.", false],
    ["The model is overloaded. Try again.", false],
    ["", false],
  ])("isNoKeyError(%j) is %p", (message, expected) => {
    expect(isNoKeyError(message)).toBe(expected);
  });
});

describe("description storage", () => {
  test("the key has the agreed name", () => {
    expect(DESCRIPTION_KEY).toBe("hm:agent-builder-description");
  });

  test.each([
    ["a saved description", { [DESCRIPTION_KEY]: "Sorts mail" }, "Sorts mail"],
    ["nothing saved", {}, ""],
  ])("loadDescription reads %s", (_label, initial, expected) => {
    expect(loadDescription(fakeStorage(initial))).toBe(expected);
  });

  test("loadDescription returns empty when storage throws", () => {
    expect(loadDescription(brokenStorage)).toBe("");
  });

  test("saveDescription stores text under the key", () => {
    const storage = fakeStorage();
    saveDescription(storage, "Sorts mail");
    expect(storage.items.get(DESCRIPTION_KEY)).toBe("Sorts mail");
  });

  test("saveDescription removes the key for empty text", () => {
    const storage = fakeStorage({ [DESCRIPTION_KEY]: "Sorts mail" });
    saveDescription(storage, "");
    expect(storage.items.has(DESCRIPTION_KEY)).toBe(false);
  });

  test("saveDescription does not throw when storage throws", () => {
    expect(() => saveDescription(brokenStorage, "Sorts mail")).not.toThrow();
    expect(() => saveDescription(brokenStorage, "")).not.toThrow();
  });

  test("clearDescription removes the key", () => {
    const storage = fakeStorage({ [DESCRIPTION_KEY]: "Sorts mail" });
    clearDescription(storage);
    expect(storage.items.has(DESCRIPTION_KEY)).toBe(false);
  });

  test("clearDescription does not throw when storage throws", () => {
    expect(() => clearDescription(brokenStorage)).not.toThrow();
  });

  test("a saved description loads back unchanged", () => {
    const storage = fakeStorage();
    saveDescription(storage, "Line one\nLine two");
    expect(loadDescription(storage)).toBe("Line one\nLine two");
  });
});
