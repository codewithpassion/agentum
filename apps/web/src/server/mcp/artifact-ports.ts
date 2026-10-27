// The `artifacts` group of the platform MCP tools: the calling run's own
// artifacts, over the artifacts service. `artifact_test` opens a version in a
// real browser through a short-lived test token, and keeps that token (and the
// URL it sits in) out of everything it returns.
import { taskFolderPath } from "@repo/db/shared";
import type {
  ArtifactPublished,
  ArtifactsPort,
  ArtifactTestInfo,
} from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import type { Principal } from "@repo/services/workspaces";
import type { ArtifactTestBrowser } from "../artifact-test/driver.ts";
import { runArtifactTest } from "../artifact-test/driver.ts";
import { formatArtifactTestResult } from "../artifact-test/format.ts";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

const FALLBACK_BASE_URL = "http://localhost";
const TRAILING_SLASHES = /\/+$/;

type TestResult = Awaited<ReturnType<typeof runArtifactTest>>;

/** Console entries, plus a line for a page that never finished loading. */
const consoleMessagesOf = (result: TestResult) => [
  ...result.consoleEntries.map(({ level, text }) => ({ level, text })),
  ...(result.loadError
    ? [
        {
          level: "error" as const,
          text: `Page did not finish loading: ${result.loadError}`,
        },
      ]
    : []),
];

const failedRequestsOf = (result: TestResult) => [
  ...result.failedRequests.map(({ url }) => ({ status: null, url })),
  ...result.badResponses.map(({ status, url }) => ({ status, url })),
];

export const createArtifactPorts = ({
  principal,
  publicBaseUrl,
  services,
  testBrowser,
}: {
  principal: Extract<Principal, { kind: "run" }>;
  publicBaseUrl?: string;
  services: Pick<
    Services,
    "agents" | "artifactShares" | "artifacts" | "library"
  >;
  testBrowser?: ArtifactTestBrowser;
}): ArtifactsPort => {
  const base = (publicBaseUrl || FALLBACK_BASE_URL).replace(
    TRAILING_SLASHES,
    ""
  );
  const urlOf = (artifactId: string) => `${base}/a/${artifactId}`;
  const published = (result: {
    artifactId: string;
    bytes: number;
    files: number;
    version: number;
    versionId: string;
  }): ArtifactPublished => ({
    artifactId: result.artifactId,
    bytes: result.bytes,
    files: result.files,
    url: urlOf(result.artifactId),
    version: result.version,
    versionId: result.versionId,
  });

  /** The version `artifact_test` opens: the numbered one, else the current. */
  const versionToTest = async (
    artifactId: string,
    number: number | undefined
  ): Promise<{ id: string; number: number }> => {
    const found =
      number === undefined
        ? (await services.artifacts.get(principal, artifactId)).currentVersion
        : (await services.artifacts.versions(principal, artifactId)).find(
            (row) => row.number === number
          );
    if (!found) {
      throw new ToolError("not_found", `Version ${number} not found.`);
    }
    return found;
  };

  /** Writes the PNG into the run's task folder and returns its library path. */
  const saveScreenshot = async (
    png: Uint8Array,
    name: string
  ): Promise<string> => {
    const agent = await services.agents.get(principal, principal.agentId);
    const path = `${taskFolderPath(agent.slug, principal.runId)}/${name}`;
    await services.library.write(principal, path, png);
    return path;
  };

  /** A thumbnail that fails to save never fails the test. */
  const setThumbnail = async (
    artifactId: string,
    versionId: string,
    png: Uint8Array
  ): Promise<void> => {
    try {
      await services.artifacts.setThumbnail(principal, {
        artifactId,
        png,
        versionId,
      });
    } catch (error) {
      console.warn(
        "artifact thumbnail not saved:",
        error instanceof Error ? error.name : "unknown error"
      );
    }
  };

  return {
    create: (input) =>
      guarded(async () =>
        published(await services.artifacts.create(principal, input))
      ),
    list: ({ cursor, kind }) =>
      guarded(async () => {
        const { items, next } = await services.artifacts.list(principal, {
          cursor,
          kind,
        });
        return {
          items: items.map((card) => ({
            artifactId: card.artifactId,
            audience: card.audience,
            currentVersion: card.currentVersion,
            description: card.description,
            kind: card.kind,
            title: card.title,
            updatedAt: card.updatedAt,
            url: urlOf(card.artifactId),
          })),
          ...(next === undefined ? {} : { next }),
        };
      }),
    read: ({ artifactId, path, version }) =>
      guarded(async () => {
        const [card, versions, file] = await Promise.all([
          services.artifacts.get(principal, artifactId),
          services.artifacts.versions(principal, artifactId),
          services.artifacts.readFile(principal, { artifactId, path, version }),
        ]);
        return {
          artifactId: card.artifactId,
          audience: card.audience,
          currentVersion: card.currentVersion.number,
          description: card.description,
          file,
          kind: card.kind,
          title: card.title,
          url: urlOf(card.artifactId),
          versions: versions.map((row) => ({
            authorKind: row.authorKind,
            createdAt: row.createdAt,
            message: row.message === "" ? null : row.message,
            number: row.number,
            versionId: row.id,
          })),
        };
      }),
    test: ({ artifactId, version, viewport }) =>
      guarded(async (): Promise<ArtifactTestInfo> => {
        if (!testBrowser) {
          throw new ToolError(
            "conflict",
            "The test browser is unavailable right now. Try again later."
          );
        }
        const shot = viewport ?? "desktop";
        const target = await versionToTest(artifactId, version);
        const { contentUrl } = await services.artifactShares.mintTestToken(
          principal,
          { artifactId, versionId: target.id }
        );
        const result = await runArtifactTest({
          browser: testBrowser,
          url: new URL(contentUrl, `${base}/`).toString(),
          viewport: shot,
        });
        const screenshotPath = await saveScreenshot(
          result.screenshot,
          `artifact-test-${target.number}-${shot}-${Date.now()}.png`
        );
        // A phone shot makes a poor card thumbnail.
        if (shot === "desktop") {
          await setThumbnail(artifactId, target.id, result.screenshot);
        }
        return {
          consoleMessages: consoleMessagesOf(result),
          failedRequests: failedRequestsOf(result),
          screenshotPath,
          snapshot: formatArtifactTestResult(result),
          title: result.title,
          version: target.number,
        };
      }),
    update: (input) =>
      guarded(async () =>
        published(await services.artifacts.update(principal, input))
      ),
  };
};
