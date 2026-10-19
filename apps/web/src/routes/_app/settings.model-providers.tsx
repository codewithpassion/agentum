import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { ProviderKeyForm } from "#/components/model-providers/provider-key-form";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/settings/model-providers")({
  loader: async () => {
    try {
      const [anthropic, openrouter] = await Promise.all([
        getTrpc().managedKeys.status.query(),
        getTrpc().modelKeys.status.query({ provider: "openrouter" }),
      ]);
      return { anthropic, openrouter };
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
  component: ModelProvidersPage,
});

function ModelProvidersPage() {
  const { anthropic, openrouter } = Route.useLoaderData();
  const router = useRouter();

  const saveAnthropic = useCallback(
    async (apiKey: string) => {
      await getTrpc().managedKeys.set.mutate({ apiKey });
      await router.invalidate();
    },
    [router]
  );

  const removeAnthropic = useCallback(async () => {
    await getTrpc().managedKeys.remove.mutate();
    await router.invalidate();
  }, [router]);

  const saveOpenRouter = useCallback(
    async (apiKey: string) => {
      await getTrpc().modelKeys.set.mutate({ apiKey, provider: "openrouter" });
      await router.invalidate();
    },
    [router]
  );

  const removeOpenRouter = useCallback(async () => {
    await getTrpc().modelKeys.remove.mutate({ provider: "openrouter" });
    await router.invalidate();
  }, [router]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Model providers</h1>
      <div className="flex flex-col gap-6">
        <ProviderKeyForm
          description="Cloudflare agents and Managed Agents both run on your workspace's own Anthropic API key. The key is stored encrypted and is never shown again; only its last four characters are."
          inputId="managed-api-key"
          onRemove={removeAnthropic}
          onSave={saveAnthropic}
          placeholder="sk-ant-..."
          status={anthropic}
          title="Anthropic API key"
        />
      </div>
      <div className="flex flex-col gap-6">
        <ProviderKeyForm
          description="Agents that run on OpenRouter models use your workspace's own OpenRouter key. The key is stored encrypted and is never shown again; only its last four characters are."
          inputId="openrouter-api-key"
          onRemove={removeOpenRouter}
          onSave={saveOpenRouter}
          placeholder="sk-or-..."
          status={openrouter}
          title="OpenRouter API key"
        />
      </div>
    </section>
  );
}
