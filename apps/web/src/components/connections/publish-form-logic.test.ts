import { expect, test } from "bun:test";
import {
  DESCRIPTION_MAX,
  emptySkill,
  parseTags,
  publishProblem,
  type SkillDraft,
  skillProblem,
  slugOf,
  toPublishSkills,
  withId,
  withName,
} from "./publish-form-logic.ts";

const complete = (overrides: Partial<SkillDraft> = {}): SkillDraft => ({
  ...emptySkill("k1"),
  description: "Answers questions about invoices.",
  id: "invoices",
  name: "Invoices",
  tags: "billing, finance",
  ...overrides,
});

test("slugOf makes a lowercase dashed slug from a name", () => {
  expect(slugOf("  Invoice Helper 2!  ")).toBe("invoice-helper-2");
  expect(slugOf("Ünïcode & symbols")).toBe("n-code-symbols");
  expect(slugOf("!!!")).toBe("");
});

test("the id follows the name until the owner types an id", () => {
  const typed = withName(emptySkill("k"), "Order Status");
  expect(typed.id).toBe("order-status");
  const edited = withId(typed, "orders");
  expect(withName(edited, "Order Status Checker").id).toBe("orders");
});

test("parseTags trims and drops empty tags", () => {
  expect(parseTags(" a , ,b,, c ")).toEqual(["a", "b", "c"]);
  expect(parseTags(" , ")).toEqual([]);
});

test("skillProblem asks for a slug id, a name, a description and one tag", () => {
  expect(skillProblem(complete())).toBeNull();
  expect(skillProblem(complete({ id: "Has Spaces" }))).toContain("id");
  expect(skillProblem(complete({ id: "" }))).toContain("id");
  expect(skillProblem(complete({ name: "  " }))).toContain("name");
  expect(skillProblem(complete({ description: " " }))).toContain("description");
  expect(skillProblem(complete({ tags: " , " }))).toContain("tag");
});

test("publishProblem needs a description of at most 2000 characters", () => {
  expect(publishProblem("  ", [complete()])).toContain("description");
  expect(publishProblem("Ok.", [complete()])).toBeNull();
  expect(publishProblem("x".repeat(DESCRIPTION_MAX), [complete()])).toBeNull();
  expect(
    publishProblem("x".repeat(DESCRIPTION_MAX + 1), [complete()])
  ).toContain(`${DESCRIPTION_MAX}`);
});

test("publishProblem keeps the skill count between one and twenty", () => {
  expect(publishProblem("Ok.", [])).toContain("between 1 and 20");
  const twenty = Array.from({ length: 20 }, (_, i) =>
    complete({ id: `skill-${i}` })
  );
  expect(publishProblem("Ok.", twenty)).toBeNull();
  const twentyOne = [...twenty, complete({ id: "extra" })];
  expect(publishProblem("Ok.", twentyOne)).toContain("between 1 and 20");
});

test("publishProblem reports the first incomplete skill", () => {
  expect(publishProblem("Ok.", [complete(), complete({ tags: "" })])).toContain(
    "tag"
  );
});

test("toPublishSkills trims text and splits tags", () => {
  expect(
    toPublishSkills([
      complete({ name: " Invoices ", tags: " billing ,finance " }),
    ])
  ).toEqual([
    {
      description: "Answers questions about invoices.",
      id: "invoices",
      name: "Invoices",
      tags: ["billing", "finance"],
    },
  ]);
});
