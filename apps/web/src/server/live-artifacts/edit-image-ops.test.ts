import { expect, test } from "bun:test";
import type { Operation } from "@repo/live-doc";
import { editMarkdownImageUrls, withStoredImages } from "./edit-image-ops";

interface JSONNode {
  attrs?: { src?: string };
  content?: JSONNode[];
  type?: string;
}

const findImages = (node: JSONNode | undefined): string[] => {
  if (!node) {
    return [];
  }
  const own = node.type === "image" && node.attrs?.src ? [node.attrs.src] : [];
  return [
    ...own,
    ...(node.content ?? []).flatMap((child) => findImages(child)),
  ];
};

test("editMarkdownImageUrls dedupes in first-seen order and ignores text, json and code spans", () => {
  const ops: Operation[] = [
    { content: { markdown: "![a](https://a.test/one.png)" }, op: "insert" },
    { content: { text: "![t](https://a.test/text.png)" }, op: "insert" },
    {
      content: { json: { content: [], type: "doc" } },
      op: "insert",
    },
    {
      content: {
        markdown: "![b](https://a.test/two.png) `![x](https://a.test/c.png)`",
      },
      op: "replace",
      target: { blockId: "b1" },
    },
    { op: "replace", target: { blockId: "b2" } },
    { content: { markdown: "![again](https://a.test/one.png)" }, op: "insert" },
  ];

  expect(editMarkdownImageUrls(ops)).toEqual([
    "https://a.test/one.png",
    "https://a.test/two.png",
  ]);
});

test("withStoredImages does not mutate the input ops", () => {
  const ops: Operation[] = [
    { content: { markdown: "![c](https://a.test/c.png)" }, op: "insert" },
    { op: "replace", target: { blockId: "b1" } },
  ];
  const before = structuredClone(ops);
  const replacements = new Map([["https://a.test/c.png", "/files/abc"]]);

  const result = withStoredImages(ops, replacements);

  expect(ops).toEqual(before);
  expect(result).not.toBe(ops);
});

test("withStoredImages converts a markdown op with a stored image into json with the stored src", () => {
  const ops: Operation[] = [
    {
      content: { markdown: "# Title\n\n![c](https://a.test/c.png)" },
      op: "insert",
    },
  ];
  const replacements = new Map([["https://a.test/c.png", "/files/abc"]]);

  const [result] = withStoredImages(ops, replacements);

  expect(result).toBeDefined();
  if (!(result && "content" in result && result.content)) {
    throw new Error("expected content");
  }
  expect("json" in result.content).toBe(true);
  const json = "json" in result.content ? result.content.json : undefined;
  expect(findImages(json as JSONNode)).toEqual(["/files/abc"]);
});

test("withStoredImages leaves a markdown op untouched when none of its images is replaced", () => {
  const ops: Operation[] = [
    {
      content: { markdown: "![u](https://a.test/unrelated.png)" },
      op: "insert",
    },
  ];
  const replacements = new Map([["https://a.test/c.png", "/files/abc"]]);

  const [result] = withStoredImages(ops, replacements);

  expect(result).toEqual({
    content: { markdown: "![u](https://a.test/unrelated.png)" },
    op: "insert",
  });
});

test("withStoredImages passes non-markdown and content-less ops through unchanged", () => {
  const textOp: Operation = {
    content: { text: "![c](https://a.test/c.png)" },
    op: "insert",
  };
  const jsonOp: Operation = {
    content: { json: { content: [], type: "doc" } },
    op: "insert",
  };
  const bareOp: Operation = { op: "replace", target: { blockId: "b1" } };
  const ops = [textOp, jsonOp, bareOp];
  const replacements = new Map([["https://a.test/c.png", "/files/abc"]]);

  const result = withStoredImages(ops, replacements);

  expect(result).toEqual(ops);
  expect(result[0]).toBe(textOp);
  expect(result[1]).toBe(jsonOp);
  expect(result[2]).toBe(bareOp);
});
