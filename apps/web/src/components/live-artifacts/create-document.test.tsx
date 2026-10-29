/** biome-ignore-all lint/suspicious/useAwait: Rejecting stubs stay synchronous. */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CreateDocumentForm, createAndOpenDocument } from "./create-document";

const stubCreate = () => Promise.resolve({ artifactId: "x" });
const stubOpen = () => undefined;

test("offers a 40px-minimum Create document button, disabled until titled", () => {
  const html = renderToStaticMarkup(
    <CreateDocumentForm create={stubCreate} open={stubOpen} />
  );
  expect(html).toContain("Create document");
  expect(html).toContain("min-h-10");
  expect(html).toContain("disabled");
});

test("creates the document with the trimmed title and opens it", async () => {
  const created: string[] = [];
  const opened: string[] = [];
  const error = await createAndOpenDocument(
    {
      create: (title) => {
        created.push(title);
        return Promise.resolve({ artifactId: "doc-1" });
      },
      open: (id) => {
        opened.push(id);
      },
    },
    "  Plan  "
  );
  expect(error).toBeUndefined();
  expect(created).toEqual(["Plan"]);
  expect(opened).toEqual(["doc-1"]);
});

test("reports the failure and does not open when creation is refused", async () => {
  const opened: string[] = [];
  const error = await createAndOpenDocument(
    {
      create: () => Promise.reject(new Error("Forbidden")),
      open: (id) => {
        opened.push(id);
      },
    },
    "T"
  );
  expect(error).toBe("Forbidden");
  expect(opened).toEqual([]);
});
