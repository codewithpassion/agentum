import { expect, test } from "bun:test";
import {
  memberMentionToken,
  mentionedMemberIds,
  readableMentions,
} from "./member-mentions";

test("member chips distinguish agent/plain mentions, deduplicate and bound recipients", () => {
  expect(
    mentionedMemberIds(
      "@agent @ann @[Ann](member:user_1) @[Again](member:user_1) @[Other](member:user_2)"
    )
  ).toEqual(["user_1", "user_2"]);
  expect(
    mentionedMemberIds(
      Array.from({ length: 20 }, (_, i) =>
        memberMentionToken(`user_${i}`, "Member")
      ).join(" ")
    )
  ).toHaveLength(10);
  expect(
    mentionedMemberIds(
      "@[Bad](member:../foreign) @[Bad](member:user@example.com)"
    )
  ).toEqual([]);
  expect(readableMentions("Please @[Ann](member:user_1)")).toBe("Please @Ann");
});
