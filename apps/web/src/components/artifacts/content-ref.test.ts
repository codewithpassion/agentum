import { expect, test } from "bun:test";
import { artifactContentPath } from "@repo/protocol/artifacts";
import { contentRef } from "./content-ref.ts";

const ARTIFACT_ID = "6f1c1d52-0c1e-4b7a-9d5e-2a3b4c5d6e7f";

const token = (claims: unknown) =>
  `hm_view_${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const url = (viewToken: string, path = "") =>
  artifactContentPath({ artifactId: ARTIFACT_ID, path, token: viewToken });

test("reads the artifact from the path and the version from the token", () => {
  const claims = { versionId: "ver_1" };
  expect(contentRef(url(token(claims)))).toEqual({
    artifactId: ARTIFACT_ID,
    versionId: "ver_1",
  });
  expect(contentRef(`https://x.test${url(token(claims), "a/b.html")}`)).toEqual(
    { artifactId: ARTIFACT_ID, versionId: "ver_1" }
  );
});

test("gives null for anything that is not a view-token content url", () => {
  expect(contentRef("")).toBeNull();
  expect(contentRef("/a/not-a-uuid/c/hm_view_x/")).toBeNull();
  expect(contentRef(url("hm_share_abc"))).toBeNull();
  expect(contentRef(url("hm_view_%%%.sig"))).toBeNull();
  expect(contentRef(url("hm_view_e30.sig"))).toBeNull();
  expect(contentRef(url(token({ versionId: 5 })))).toBeNull();
  expect(contentRef(url(token("text")))).toBeNull();
});
