import { describe, expect, test } from "bun:test";
import type {
  DeskCardKind,
  RailCard,
  RailItem,
  RailMail,
  RailSetupStep,
  RailView,
} from "@repo/db/shared";
import {
  cardView,
  deskCardOf,
  expiryNote,
  findCard,
  howItGotHere,
  isListed,
  itemAfterAnswer,
  keepsSendError,
  nextItemId,
  pruneAnswered,
  selectItem,
  selectionId,
  sendFailureText,
} from "./pane-logic.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const mail: RailMail = {
  body: "Thanks, see you Monday.",
  subject: "Offer",
  theyWrote: null,
  to: ["ada@example.com"],
};

const card = (overrides: Partial<RailCard> = {}): RailCard => ({
  agentId: "agent-1",
  agentName: "Ada",
  at: "2026-10-31T09:00:00.000Z",
  detail: "",
  expiresAt: null,
  id: "card-1",
  kind: "question",
  mail: null,
  passedOnBy: null,
  runId: "run-1",
  status: "Waiting for an answer",
  threadId: null,
  title: "Which folder?",
  ...overrides,
});

const item = (...cards: [RailCard, ...RailCard[]]): RailItem => ({
  assigneeName: null,
  assigneeUserId: null,
  cards,
  dueAt: null,
  escalatedToMe: false,
  id: cards[0].id,
  mine: true,
});

const view = (
  needsYou: RailItem[],
  setup: RailSetupStep[] = []
): Pick<RailView, "needsYou" | "setup"> => ({ needsYou, setup });

describe("cardView", () => {
  test("a held mail approval gets the mail view", () => {
    expect(cardView(card({ kind: "approval", mail }))).toBe("mail");
  });

  test("an approval without a mail gets the body view", () => {
    expect(cardView(card({ kind: "approval", mail: null }))).toBe("body");
  });

  test("the other kinds get the body view", () => {
    const kinds: RailCard["kind"][] = [
      "question",
      "takeover",
      "skill_proposal",
      "inbox_reply",
      "library_conflict",
      "wiki_suggestion",
    ];
    for (const kind of kinds) {
      expect(cardView(card({ kind }))).toBe("body");
    }
  });

  test("a problem gets the problem view", () => {
    expect(cardView(card({ kind: "problem" }))).toBe("problem");
  });
});

describe("selectItem", () => {
  const first = item(card({ id: "a1" }));
  const grouped = item(card({ id: "b1" }), card({ id: "b2" }));
  const listed = view([first, grouped], ["ai_account", "first_agent"]);

  test("a setup id opens that setup step", () => {
    expect(selectItem(listed, "setup:first_agent")).toEqual({
      kind: "setup",
      step: "first_agent",
    });
  });

  test("a setup id that is not in the view falls back to the default", () => {
    expect(selectItem(view([first]), "setup:ai_account")).toEqual({
      item: first,
      kind: "item",
    });
  });

  test("an item id opens that item", () => {
    expect(selectItem(listed, "b1")).toEqual({ item: grouped, kind: "item" });
  });

  test("a card id inside an item opens that item", () => {
    expect(selectItem(listed, "b2")).toEqual({ item: grouped, kind: "item" });
  });

  test("no id falls back to the first setup step when there is setup", () => {
    expect(selectItem(listed, undefined)).toEqual({
      kind: "setup",
      step: "ai_account",
    });
  });

  test("no id falls back to the first item when there is no setup", () => {
    expect(selectItem(view([first, grouped]), undefined)).toEqual({
      item: first,
      kind: "item",
    });
  });

  test("an unknown or finished id falls back to the default", () => {
    expect(selectItem(listed, "gone")).toEqual({
      kind: "setup",
      step: "ai_account",
    });
    expect(selectItem(view([first]), "gone")).toEqual({
      item: first,
      kind: "item",
    });
  });

  test("an empty view selects nothing", () => {
    expect(selectItem(view([]), undefined)).toBeNull();
    expect(selectItem(view([]), "gone")).toBeNull();
  });

  test("selectionId gives the id a setup step or an item is stored under", () => {
    expect(selectionId({ kind: "setup", step: "ai_account" })).toBe(
      "setup:ai_account"
    );
    expect(selectionId({ item: grouped, kind: "item" })).toBe("b1");
  });
});

describe("isListed", () => {
  const first = item(card({ id: "a1" }));
  const grouped = item(card({ id: "b1" }), card({ id: "b2" }));
  const listed = view([first, grouped], ["first_agent"]);

  test("an item id, a card id inside an item and a setup id are listed", () => {
    expect(isListed(listed, "a1")).toBe(true);
    expect(isListed(listed, "b1")).toBe(true);
    expect(isListed(listed, "b2")).toBe(true);
    expect(isListed(listed, "setup:first_agent")).toBe(true);
  });

  test("an id from another item or a setup step not shown is not listed", () => {
    expect(isListed(listed, "gone")).toBe(false);
    expect(isListed(listed, "setup:ai_account")).toBe(false);
    expect(isListed(view([]), "a1")).toBe(false);
  });
});

describe("findCard", () => {
  test("finds a card in any item", () => {
    const grouped = item(card({ id: "b1" }), card({ id: "b2" }));
    expect(findCard(view([item(card({ id: "a1" })), grouped]), "b2")?.id).toBe(
      "b2"
    );
  });

  test("gives nothing for an unknown id or no view", () => {
    expect(findCard(view([item(card({ id: "a1" }))]), "gone")).toBeUndefined();
    expect(findCard(null, "a1")).toBeUndefined();
  });
});

describe("keepsSendError", () => {
  test("keeps the error through the move its own answer made", () => {
    expect(keepsSendError(undefined, "a1")).toBe(true);
    expect(keepsSendError("b1", "b1")).toBe(true);
  });

  test("drops the error once another item is open", () => {
    expect(keepsSendError("b1", "c1")).toBe(false);
  });

  test("keeps it when nothing is open after the answer", () => {
    expect(keepsSendError(null, null)).toBe(true);
  });
});

describe("sendFailureText", () => {
  test("names the mail and its first recipient", () => {
    expect(
      sendFailureText(
        { ...mail, subject: "Team page", to: ["priya@example.com", "x@y.z"] },
        "SMTP is down"
      )
    ).toBe(
      'Allowed, but the mail "Team page" to priya@example.com could not be sent: SMTP is down'
    );
  });

  test("leaves the recipient out when there is none", () => {
    expect(
      sendFailureText({ ...mail, subject: "Offer", to: [] }, "SMTP is down")
    ).toBe('Allowed, but the mail "Offer" could not be sent: SMTP is down');
  });

  test("falls back to the plain line when there is no mail", () => {
    const plain = "Allowed, but the mail could not be sent: SMTP is down";
    expect(sendFailureText(null, "SMTP is down")).toBe(plain);
    expect(sendFailureText(undefined, "SMTP is down")).toBe(plain);
  });
});

describe("nextItemId", () => {
  const a = item(card({ id: "a1" }));
  const b = item(card({ id: "b1" }));
  const c = item(card({ id: "c1" }));

  test("gives the entry after a middle entry", () => {
    expect(
      nextItemId(
        view([a, b, c], ["ai_account", "first_agent"]),
        "setup:first_agent"
      )
    ).toBe("a1");
    expect(nextItemId(view([a, b, c]), "a1")).toBe("b1");
  });

  test("gives the entry before the last entry", () => {
    expect(nextItemId(view([a, b, c]), "c1")).toBe("b1");
  });

  test("gives null when there is no other entry", () => {
    expect(nextItemId(view([a]), "a1")).toBeNull();
    expect(nextItemId(view([], ["ai_account"]), "setup:ai_account")).toBeNull();
  });

  test("gives the first entry for an unknown id", () => {
    expect(nextItemId(view([a, b]), "zzz")).toBe("a1");
  });

  test("gives null for an unknown id when the list is empty", () => {
    expect(nextItemId(view([]), "zzz")).toBeNull();
  });

  test("walks setup steps first, then items", () => {
    expect(
      nextItemId(view([a], ["ai_account", "first_agent"]), "setup:ai_account")
    ).toBe("setup:first_agent");
  });
});

describe("itemAfterAnswer", () => {
  test("a grouped item stays put under its first remaining card", () => {
    const grouped = item(card({ id: "g1" }), card({ id: "g2" }));
    const listed = view([grouped, item(card({ id: "x1" }))]);
    expect(itemAfterAnswer(listed, grouped, "g1")).toBe("g2");
    expect(itemAfterAnswer(listed, grouped, "g2")).toBe("g1");
  });

  test("a single-card item moves on to the next entry", () => {
    const single = item(card({ id: "s1" }));
    const listed = view([single, item(card({ id: "t1" }))]);
    expect(itemAfterAnswer(listed, single, "s1")).toBe("t1");
  });

  test("a single-card last item moves back to the entry before it", () => {
    const single = item(card({ id: "s1" }));
    const listed = view([item(card({ id: "t1" })), single]);
    expect(itemAfterAnswer(listed, single, "s1")).toBe("t1");
  });
});

describe("expiryNote", () => {
  test("shows the time left under four hours", () => {
    expect(expiryNote(at(3 * HOUR + 59 * MIN), NOW)).toBe("expires in 4 h");
  });

  test("hides it at exactly four hours", () => {
    expect(expiryNote(at(4 * HOUR), NOW)).toBeNull();
  });

  test("hides it when the expiry is days away", () => {
    expect(expiryNote(at(3 * 24 * HOUR), NOW)).toBeNull();
  });

  test("hides it when there is no expiry", () => {
    expect(expiryNote(null, NOW)).toBeNull();
  });

  test("hides it when the expiry is not a time", () => {
    expect(expiryNote("not a date", NOW)).toBeNull();
  });

  test("says expired once the time has passed", () => {
    expect(expiryNote(at(-MIN), NOW)).toBe("expired");
  });
});

describe("deskCardOf", () => {
  test("a problem card omits the needs-you kind and the optional ids", () => {
    const problem = card({
      agentName: "Ada",
      id: "p1",
      kind: "problem",
      runId: null,
      status: "Failed to run",
      title: "Mailbox locked",
    });
    expect(deskCardOf(problem)).toStrictEqual({
      agentId: "agent-1",
      at: "2026-10-31T09:00:00.000Z",
      band: { text: "Failed to run", tone: "waiting" },
      id: "p1",
      kind: "request",
      lane: "needs_you",
      startedBy: "Ada",
      title: "Mailbox locked",
    });
  });

  test("an approval keeps its run and thread and starts by the passer", () => {
    const approval = card({
      id: "a1",
      kind: "approval",
      mail,
      passedOnBy: "Dom",
      threadId: "thread-2",
    });
    expect(deskCardOf(approval)).toStrictEqual({
      agentId: "agent-1",
      at: "2026-10-31T09:00:00.000Z",
      band: { text: "Waiting for an answer", tone: "waiting" },
      id: "a1",
      kind: "request",
      lane: "needs_you",
      needsYouKind: "approval",
      runId: "run-1",
      startedBy: "Dom",
      threadId: "thread-2",
      title: "Which folder?",
    });
  });

  test("puts the detail in the band, not the status", () => {
    const proposal = card({
      detail: "Version 3: tighter wording",
      kind: "skill_proposal",
      status: "Waiting for review",
    });
    expect(deskCardOf(proposal).band).toStrictEqual({
      text: "Version 3: tighter wording",
      tone: "waiting",
    });
  });

  test("falls back to the status when the detail is empty", () => {
    expect(
      deskCardOf(card({ detail: "", status: "Reply ready" })).band
    ).toEqual({ text: "Reply ready", tone: "waiting" });
  });

  test("maps each kind to its desk kind", () => {
    const expected: [RailCard["kind"], DeskCardKind][] = [
      ["skill_proposal", "proposal"],
      ["trigger_proposal", "proposal"],
      ["routine_proposal", "proposal"],
      ["inbox_reply", "thread"],
      ["library_conflict", "conflict"],
      ["wiki_suggestion", "request"],
    ];
    for (const [kind, deskKind] of expected) {
      expect(deskCardOf(card({ kind })).kind).toBe(deskKind);
    }
  });
});

describe("howItGotHere", () => {
  const formatAt = (iso: string) => `at ${iso.slice(11, 16)}`;

  test("names the agent that started it and its status", () => {
    expect(howItGotHere(card(), formatAt)).toEqual([
      "Ada started this at 09:00.",
      "Now: Waiting for an answer.",
    ]);
  });

  test("names the person who passed it on and the agent it went to", () => {
    expect(howItGotHere(card({ passedOnBy: "Dom" }), formatAt)).toEqual([
      "Dom started this at 09:00.",
      "Passed on to Ada.",
      "Now: Waiting for an answer.",
    ]);
  });

  test("says an email started a mail card", () => {
    expect(howItGotHere(card({ kind: "approval", mail }), formatAt)[0]).toBe(
      "An email started this at 09:00."
    );
  });

  test("says someone started a card with no agent name", () => {
    expect(howItGotHere(card({ agentName: "" }), formatAt)[0]).toBe(
      "Someone started this at 09:00."
    );
  });
});

describe("pruneAnswered", () => {
  const a = card({ id: "a" });
  const b = card({ id: "b" });
  const c = card({ id: "c" });

  test("nothing answered returns the list as it is", () => {
    const list = view([item(a)]);
    expect(pruneAnswered(list, new Set())).toBe(list);
  });

  test("an item whose cards are all answered goes", () => {
    expect(pruneAnswered(view([item(a), item(b)]), new Set(["a"]))).toEqual(
      view([item(b)])
    );
  });

  test("a group keeps its other cards and takes its id from the first left", () => {
    const { needsYou } = pruneAnswered(view([item(a, b, c)]), new Set(["a"]));
    expect(needsYou.map((entry) => entry.id)).toEqual(["b"]);
    expect(needsYou.flatMap((entry) => entry.cards.map((x) => x.id))).toEqual([
      "b",
      "c",
    ]);
  });

  test("setup steps stay", () => {
    expect(
      pruneAnswered(view([item(a)], ["ai_account"]), new Set(["a"])).setup
    ).toEqual(["ai_account"]);
  });
});
