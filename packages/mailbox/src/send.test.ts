// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Harbourmaster: tests for the pure send helpers.

import { describe, expect, test } from "bun:test";
import type { OutgoingDraft } from "@repo/services/mail/types";
import {
  bodyOf,
  buildSendMessage,
  escapeHtml,
  fromDomain,
  stripHtmlToText,
  textToHtml,
} from "./send.ts";

const plainDraft: OutgoingDraft = {
  cc: [],
  from: "agent@example.com",
  subject: "Hello",
  text: "Line one\nLine two",
  to: ["person@example.org"],
};

describe("escapeHtml", () => {
  test("escapes all five special characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  test("returns an empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("textToHtml", () => {
  test("turns newlines into br tags inside a pre-wrap block", () => {
    expect(textToHtml("a\nb")).toBe(
      '<div style="white-space:pre-wrap">a<br>b</div>'
    );
  });

  test("escapes markup in the text", () => {
    expect(textToHtml("<b>hi</b>")).toBe(
      '<div style="white-space:pre-wrap">&lt;b&gt;hi&lt;/b&gt;</div>'
    );
  });

  test("returns an empty string for empty input", () => {
    expect(textToHtml("")).toBe("");
  });
});

describe("stripHtmlToText", () => {
  test("drops style and script blocks and replaces tags with spaces", () => {
    const html =
      "<style>p { color: red }</style><p>Hello</p><script>alert(1)</script><b>world</b>";
    expect(stripHtmlToText(html)).toBe("Hello world");
  });

  test("collapses whitespace and trims", () => {
    expect(stripHtmlToText("  <div>a</div>\n\n  <div>b</div>  ")).toBe("a b");
  });
});

describe("buildSendMessage", () => {
  test("builds a plain text draft with generated html and no cc", () => {
    const message = buildSendMessage(plainDraft);
    expect(message).toEqual({
      from: "agent@example.com",
      headers: {},
      html: textToHtml("Line one\nLine two"),
      subject: "Hello",
      text: "Line one\nLine two",
      to: ["person@example.org"],
    });
    expect("cc" in message).toBe(false);
  });

  test("sets cc when the draft has recipients in cc", () => {
    const message = buildSendMessage({
      ...plainDraft,
      cc: ["copy@example.org"],
    });
    expect(message.cc).toEqual(["copy@example.org"]);
  });

  test("keeps the draft html when it is given", () => {
    const message = buildSendMessage({ ...plainDraft, html: "<p>Rich</p>" });
    expect(message.html).toBe("<p>Rich</p>");
  });

  test("never sets Message-ID, which Email Sending rejects", () => {
    const plain = buildSendMessage(plainDraft);
    const reply = buildSendMessage(plainDraft, {
      inReplyTo: "orig@example.org",
      references: ["orig@example.org"],
    });
    for (const message of [plain, reply]) {
      expect(
        Object.keys(message.headers ?? {}).map((key) => key.toLowerCase())
      ).not.toContain("message-id");
    }
  });

  test("adds In-Reply-To and References for a reply", () => {
    const message = buildSendMessage(plainDraft, {
      inReplyTo: "orig@example.org",
      references: ["first@example.org", "orig@example.org"],
    });
    expect(message.headers).toEqual({
      "In-Reply-To": "<orig@example.org>",
      References: "<first@example.org> <orig@example.org>",
    });
  });
});

describe("bodyOf", () => {
  test("returns the text with isHtml false when there is text", () => {
    expect(bodyOf({ ...plainDraft, html: "<p>x</p>" })).toEqual({
      body: "Line one\nLine two",
      isHtml: false,
    });
  });

  test("returns the text with isHtml false when there is no html", () => {
    expect(bodyOf(plainDraft)).toEqual({
      body: "Line one\nLine two",
      isHtml: false,
    });
  });

  test("falls back to the html when the text is empty", () => {
    expect(bodyOf({ ...plainDraft, html: "<p>x</p>", text: "" })).toEqual({
      body: "<p>x</p>",
      isHtml: true,
    });
  });
});

describe("fromDomain", () => {
  test("returns the lowercased domain of a mixed-case address", () => {
    expect(fromDomain("Agent@Example.com")).toBe("example.com");
  });

  test("returns null when there is no at sign", () => {
    expect(fromDomain("no-at")).toBeNull();
  });

  test("returns null when the domain is empty", () => {
    expect(fromDomain("x@")).toBeNull();
  });
});
