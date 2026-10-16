import { describe, expect, test } from "bun:test";
import { stripAttachmentMarkers } from "./attachments.ts";

describe("stripAttachmentMarkers", () => {
  test("returns text unchanged when there is no marker", () => {
    const text = "plain reply\n\nwith   spacing ";
    expect(stripAttachmentMarkers(text)).toBe(text);
  });

  test("removes a marker at the end of a line", () => {
    expect(stripAttachmentMarkers("Here [ATTACHMENT:/w/report.md]")).toBe(
      "Here"
    );
  });

  test("removes an inline marker and its preceding space", () => {
    expect(stripAttachmentMarkers("a [ATTACHMENT:x] b")).toBe("a b");
  });

  test("tidies whitespace left by markers on their own line", () => {
    const text =
      "Here it is [ATTACHMENT:x.png] ok\n[ATTACHMENT:y.png]\n\n\n\nDone  \n";
    expect(stripAttachmentMarkers(text)).toBe("Here it is ok\n\nDone");
  });
});
