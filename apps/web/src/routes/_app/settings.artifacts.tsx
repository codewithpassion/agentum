import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { LinksSwitchSection } from "#/components/artifacts/links-switch";
import { getTrpc } from "#/integrations/trpc/client";

const isUnauthorized = (error: unknown): boolean =>
  error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED";

/**
 * The A.1 contract has no workspace-level read of the link switch, so read it
 * from the first artifact's detail (`linksEnabled` is a workspace value).
 * Without an artifact, or when the read fails, show the default: on.
 */
async function readLinksEnabled(): Promise<boolean> {
  try {
    const trpc = getTrpc();
    const { items } = await trpc.artifacts.list.query({});
    const [first] = items;
    if (first === undefined) {
      return true;
    }
    const detail = await trpc.artifacts.get.query({
      artifactId: first.artifactId,
    });
    return detail.linksEnabled;
  } catch (error) {
    if (isUnauthorized(error)) {
      throw redirect({ to: "/login" });
    }
    return true;
  }
}

export const Route = createFileRoute("/_app/settings/artifacts")({
  loader: async () => ({ linksEnabled: await readLinksEnabled() }),
  component: ArtifactsSettingsPage,
});

function ArtifactsSettingsPage() {
  const { linksEnabled } = Route.useLoaderData();
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Artifacts</h1>
      <p className="text-muted-foreground text-sm">
        Artifacts are pages, documents and dashboards that agents make. Members
        who own one, and admins, can share it with a link. Every open of a link
        is logged.
      </p>
      <LinksSwitchSection initialEnabled={linksEnabled} />
    </section>
  );
}
