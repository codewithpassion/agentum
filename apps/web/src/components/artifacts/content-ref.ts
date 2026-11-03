import { parseArtifactContentPath } from "@repo/protocol/artifacts";
import { ARTIFACT_VIEW_TOKEN } from "@repo/protocol/token-prefixes";

export interface ContentRef {
  artifactId: string;
  versionId: string;
}

const decodeBase64Url = (text: string): string | null => {
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    return new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0))
    );
  } catch {
    return null;
  }
};

/**
 * The artifact and version a content URL was minted for, read from the path
 * and from the claims in the view token. The claims are not verified here. The
 * server checks the signature on every content request, and `artifacts.callTool`
 * checks that the version belongs to the artifact and is published, so a forged
 * value only gets the viewer a refusal.
 */
export const contentRef = (contentUrl: string): ContentRef | null => {
  let pathname: string;
  try {
    ({ pathname } = new URL(contentUrl, "http://content.invalid"));
  } catch {
    return null;
  }
  const parsed = parseArtifactContentPath(pathname);
  if (parsed === null) {
    return null;
  }
  const body = ARTIFACT_VIEW_TOKEN.strip(parsed.token);
  if (body === null) {
    return null;
  }
  const [payload = ""] = body.split(".");
  const json = payload ? decodeBase64Url(payload) : null;
  if (json === null) {
    return null;
  }
  try {
    const claims: unknown = JSON.parse(json);
    const versionId =
      typeof claims === "object" && claims !== null && "versionId" in claims
        ? claims.versionId
        : null;
    return typeof versionId === "string" && versionId !== ""
      ? { artifactId: parsed.artifactId, versionId }
      : null;
  } catch {
    return null;
  }
};
