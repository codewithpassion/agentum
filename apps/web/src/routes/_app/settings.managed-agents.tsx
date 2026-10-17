import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { formatDistanceToNow } from "date-fns";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/settings/managed-agents")({
  loader: async () => {
    try {
      return await getTrpc().managedKeys.status.query();
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      throw error;
    }
  },
  component: ManagedAgentsPage,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function keyState(status: {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}): string {
  if (!status.configured || status.hint === null) {
    return "No key set";
  }
  const set = status.updatedAt
    ? formatDistanceToNow(new Date(status.updatedAt), { addSuffix: true })
    : "recently";
  return `Key ending in ${status.hint}, set ${set}`;
}

function ManagedAgentsPage() {
  const status = Route.useLoaderData();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );

  const saveKey = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const apiKey = draft.trim();
      if (apiKey === "") {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await getTrpc().managedKeys.set.mutate({ apiKey });
        setDraft("");
        toast.success("Key saved");
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [draft, router]
  );

  const removeKey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await getTrpc().managedKeys.remove.mutate();
      toast.success("Key removed");
      await router.invalidate();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [router]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Anthropic</h1>
      <h2 className="font-heading text-foreground text-xl">
        Anthropic API key
      </h2>
      <p className="text-muted-foreground text-sm">
        Cloudflare agents and Managed Agents both run on your workspace's own
        Anthropic API key. The key is stored encrypted and is never shown again;
        only its last four characters are.
      </p>
      <p className="text-foreground text-sm">{keyState(status)}</p>
      <form className="flex flex-col gap-4" onSubmit={saveKey}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="managed-api-key">Anthropic API key</FieldLabel>
            <Input
              autoComplete="off"
              disabled={busy}
              id="managed-api-key"
              onChange={handleDraft}
              placeholder="sk-ant-..."
              type="password"
              value={draft}
            />
          </Field>
        </FieldGroup>
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button disabled={busy || draft.trim() === ""} type="submit">
            Save key
          </Button>
          {status.configured ? (
            <Button
              disabled={busy}
              onClick={removeKey}
              type="button"
              variant="outline"
            >
              Remove key
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
