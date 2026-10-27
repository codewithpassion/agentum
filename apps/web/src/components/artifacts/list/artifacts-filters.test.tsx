import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactsFilters,
  parseKind,
  parseMadeBy,
} from "./artifacts-filters.tsx";

const noop = () => undefined;

describe("parseKind", () => {
  test("maps known kinds", () => {
    expect(parseKind("page")).toBe("page");
    expect(parseKind("app")).toBe("app");
  });
  test("returns undefined for empty and unknown values", () => {
    expect(parseKind("")).toBeUndefined();
    expect(parseKind("video")).toBeUndefined();
  });
});

describe("parseMadeBy", () => {
  test("maps known makers", () => {
    expect(parseMadeBy("agent")).toBe("agent");
    expect(parseMadeBy("person")).toBe("person");
  });
  test("returns undefined for empty and unknown values", () => {
    expect(parseMadeBy("")).toBeUndefined();
    expect(parseMadeBy("robot")).toBeUndefined();
  });
});

describe("ArtifactsFilters", () => {
  test("renders every option and the test ids", () => {
    const html = renderToStaticMarkup(
      <ArtifactsFilters filters={{}} onChange={noop} />
    );
    for (const text of [
      "All kinds",
      "Page",
      "Doc",
      "Dashboard",
      "App",
      "Anyone",
      "Agents",
      "People",
      "Shared by link",
    ]) {
      expect(html).toContain(text);
    }
    for (const id of ["kind", "madeby", "shared"]) {
      expect(html).toContain(`data-testid="artifacts-filter-${id}"`);
    }
    expect(html).toContain('aria-checked="false"');
  });

  test("shows the selected values and the checked box", () => {
    const html = renderToStaticMarkup(
      <ArtifactsFilters
        filters={{ kind: "doc", madeBy: "agent", shared: true }}
        onChange={noop}
      />
    );
    expect(html).toContain('value="doc" selected=""');
    expect(html).toContain('value="agent" selected=""');
    expect(html).toContain('aria-checked="true"');
  });
});
