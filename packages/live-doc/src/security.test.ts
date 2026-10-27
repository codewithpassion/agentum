// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures assert the expected blocks exist.
import { expect, test } from "bun:test";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  type XmlElement,
  type XmlText,
} from "yjs";
import { LiveDocument } from "./document";
import {
  fromMarkdown,
  safeLink,
  sanitizeJSON,
  schema,
  toMarkdown,
} from "./schema";

const urls = [
  "javascript:alert(1)",
  "java\nscript:alert(1)",
  "data:text/html,test",
  "vbscript:msgbox(1)",
  "//evil.test/image",
  "/\\evil.test",
  "/%2fevil.test",
  "https://ok.test\u0000.evil.test",
  "file:///etc/passwd",
];
const styles = [
  "url(https://evil.test)",
  "expression(alert(1))",
  "var(--attack)",
  "red; background:url(x)",
  '#fff" onmouseover=alert(1)',
];
test("hostile corpus for JSON, markdown, create/import, restore and agent content", () => {
  for (const url of urls) {
    expect(safeLink(url)).toBeUndefined();
  }
  for (const url of urls) {
    for (const style of styles) {
      const hostile = {
        content: [
          { attrs: { src: url }, type: "script" },
          { attrs: { onerror: "alert(1)", src: url }, type: "image" },
          {
            attrs: { onclick: "alert(1)", style },
            content: [
              {
                marks: [
                  { attrs: { href: url }, type: "link" },
                  { attrs: { color: style }, type: "textStyle" },
                  { type: "evil" },
                ],
                text: "text <script> is text",
                type: "text",
              },
            ],
            type: "paragraph",
          },
        ],
        type: "doc",
      };
      const clean = sanitizeJSON(hostile);
      const json = JSON.stringify(clean);
      expect(json).not.toContain('"href"');
      expect(json).not.toContain('"image"');
      expect(json).not.toContain('"style"');
      expect(json).not.toContain('"onclick"');
      schema.nodeFromJSON(clean).check();
      const live = new LiveDocument(new Doc());
      live.import({ json: hostile }, "restore");
      expect(live.json()).toEqual(clean);
      live.apply([{ content: { json: hostile }, op: "insert" }], {});
      schema.nodeFromJSON(live.json()).check();
      const markdown = fromMarkdown(
        `<script src="${url}">attack</script>\n\n[bad](${url})\n\n![x](${url})`
      );
      expect(JSON.stringify(markdown)).not.toContain('"image"');
      expect(JSON.stringify(markdown)).not.toContain('"html"');
      live.destroy();
      live.doc.destroy();
    }
  }
});
test("own blob allowlist prevents third-party requests; safe links and theme colors survive", () => {
  const policy = { ownBlobUrls: new Set(["/files/owned/image.png"]) };
  const json = sanitizeJSON(
    {
      content: [
        { attrs: { src: "/files/owned/image.png" }, type: "image" },
        { attrs: { src: "/files/other/image.png" }, type: "image" },
        { attrs: { src: "https://evil/image.png" }, type: "image" },
      ],
      type: "doc",
    },
    policy
  );
  expect(json.content).toHaveLength(1);
  expect(safeLink("https://example.com/a")).toBe("https://example.com/a");
  expect(safeLink("mailto:a@example.com")).toBe("mailto:a@example.com");
  expect(safeLink("/a/abc")).toBe("/a/abc");
});
test("raw hostile Yjs update is rejected without mutating live state", () => {
  const live = new LiveDocument(new Doc());
  live.import({ text: "safe" }, "init");
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(live.doc));
  const el = replica.getXmlFragment("content").get(0) as XmlElement;
  const text = el.get(0) as XmlText;
  text.format(0, text.length, { link: { href: "javascript:alert(1)" } });
  const before = encodeStateAsUpdate(live.doc);
  expect(() =>
    live.applyUpdate(encodeStateAsUpdate(replica), "socket")
  ).toThrow("invalid_content");
  expect(encodeStateAsUpdate(live.doc)).toEqual(before);
});
test("deterministic hostile JSON fuzz validates schema and sanitizer idempotence", () => {
  let seed = 123_456;
  const random = () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: Deterministic unsigned LCG for reproducible fuzzing.
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const types = [
    "paragraph",
    "heading",
    "text",
    "image",
    "script",
    "iframe",
    "table",
    "tableRow",
    "tableCell",
    "pending",
    "mention",
    "date",
    "html",
    "taskList",
    "taskItem",
  ];
  const generate = (depth: number): unknown => ({
    attrs: {
      checked: true,
      color: styles[random() % styles.length],
      href: urls[random() % urls.length],
      level: random() % 9,
      src: urls[random() % urls.length],
      style: styles[random() % styles.length],
    },
    content: depth
      ? Array.from({ length: random() % 4 }, () => generate(depth - 1))
      : [],
    marks: [{ attrs: { href: urls[random() % urls.length] }, type: "link" }],
    text: random() % 2 ? "<img src=x onerror=alert(1)>" : "plain",
    type: types[random() % types.length],
  });
  for (let i = 0; i < 1000; i += 1) {
    const clean = sanitizeJSON({ content: [generate(4)], type: "doc" });
    schema.nodeFromJSON(clean).check();
    expect(sanitizeJSON(clean)).toEqual(clean);
    expect(() => toMarkdown(clean)).not.toThrow();
  }
});

test("sanitized schema renders hostile corpus as inert DOM, with no unsafe attributes or remote images", async () => {
  const { Window } = await import("happy-dom");
  const { DOMSerializer } = await import("@tiptap/pm/model");
  const window = new Window();
  const { document } = window;
  for (const url of urls) {
    const clean = sanitizeJSON({
      content: [
        {
          content: [
            {
              marks: [
                { attrs: { href: url }, type: "link" },
                { attrs: { color: "url(https://evil)" }, type: "textStyle" },
              ],
              text: '<img src="x" onerror="alert(1)">',
              type: "text",
            },
          ],
          type: "paragraph",
        },
        { attrs: { src: url }, type: "image" },
      ],
      type: "doc",
    });
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      schema.nodeFromJSON(clean).content,
      { document: document as unknown as Document }
    );
    const container = document.createElement("div");
    container.append(
      fragment as unknown as Parameters<typeof container.append>[0]
    );
    expect(
      container.querySelector(
        "script, iframe, img, [onerror], [onclick], [style], a"
      )
    ).toBeNull();
    expect(container.textContent).toBe('<img src="x" onerror="alert(1)">');
  }
  await window.happyDOM.close();
});
