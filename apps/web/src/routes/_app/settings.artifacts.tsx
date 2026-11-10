import { createFileRoute } from "@tanstack/react-router";
import { LinksSwitchSection } from "#/components/artifacts/links-switch";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const Route = createFileRoute("/_app/settings/artifacts")({
  loader: () =>
    loadOrLogin(async () => {
      const { enabled } = await getTrpc().artifacts.linksEnabled.query();
      return { linksEnabled: enabled };
    }),
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
