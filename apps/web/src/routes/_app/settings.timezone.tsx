import { useAuth } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { TimezoneForm } from "#/components/settings/timezone-form";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import { errorMessage } from "#/lib/error-message";

export const PAGE_HEADING = "Timezone";

export const Route = createFileRoute("/_app/settings/timezone")({
  loader: async () =>
    loadOrLogin(async () => await getTrpc().workspaces.timezone.query()),
  component: TimezonePage,
});

function TimezonePage() {
  const { timezone: savedZone } = Route.useLoaderData();
  const { orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";
  const [value, setValue] = useState(savedZone);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback((next: string) => {
    setSaved(false);
    setValue(next);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await getTrpc().workspaces.setTimezone.mutate({
        timezone: value,
      });
      setValue(result.timezone);
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [value]);

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="mb-6 font-heading text-3xl text-foreground">
        {PAGE_HEADING}
      </h1>
      <TimezoneForm
        error={error}
        isAdmin={isAdmin}
        onChange={change}
        onSave={save}
        saved={saved}
        saving={saving}
        value={value}
      />
    </section>
  );
}
