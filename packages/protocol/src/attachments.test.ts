import { describe, expect, test } from "bun:test";
import {
  extractAttachmentMarkers,
  stripAttachmentMarkers,
} from "./attachments.ts";

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

describe("extractAttachmentMarkers", () => {
  test("returns text unchanged when there is no marker", () => {
    const text = "plain reply\n\nwith   spacing ";
    expect(extractAttachmentMarkers(text)).toEqual({ paths: [], text });
  });

  test("collects paths in order and de-duplicates them", () => {
    const result = extractAttachmentMarkers(
      "[ATTACHMENT:a.png] and [ATTACHMENT:b.txt] then [ATTACHMENT:a.png]"
    );
    expect(result.paths).toEqual(["a.png", "b.txt"]);
  });

  test("keeps spaces inside a path and trims the edges", () => {
    const result = extractAttachmentMarkers(
      "see [ATTACHMENT:  my docs/report 1.pdf ]"
    );
    expect(result.paths).toEqual(["my docs/report 1.pdf"]);
  });

  test("removes markers and tidies the text around them", () => {
    const text =
      "Here it is [ATTACHMENT:x.png] ok\n[ATTACHMENT:y.png]\n\n\n\nDone  \n";
    expect(extractAttachmentMarkers(text).text).toBe("Here it is ok\n\nDone");
  });
});
