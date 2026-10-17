import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { CreateSecretDialog } from "#/components/secrets/create-secret-dialog";
import { DeleteSecretDialog } from "#/components/secrets/delete-secret-dialog";
import { EditRulesDialog } from "#/components/secrets/edit-rules-dialog";
import { ReplaceValueDialog } from "#/components/secrets/replace-value-dialog";
import type {
  ActiveDialog,
  SecretRecord,
} from "#/components/secrets/secret-model";
import { SecretsTable } from "#/components/secrets/secrets-table";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/settings/secrets")({
  loader: async () => {
    try {
      return await getTrpc().secrets.list.query();
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
  component: SecretsPage,
});

function SecretsPage() {
  const secrets = Route.useLoaderData();
  const router = useRouter();
  const [active, setActive] = useState<ActiveDialog | null>(null);

  const openCreate = useCallback(() => setActive({ kind: "create" }), []);
  const openReplace = useCallback(
    (secret: SecretRecord) => setActive({ kind: "replace", secret }),
    []
  );
  const openRules = useCallback(
    (secret: SecretRecord) => setActive({ kind: "rules", secret }),
    []
  );
  const openDelete = useCallback(
    (secret: SecretRecord) => setActive({ kind: "delete", secret }),
    []
  );
  const close = useCallback(() => setActive(null), []);

  const done = useCallback(async () => {
    await router.invalidate();
    setActive(null);
  }, [router]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Secrets</h1>
        <Button onClick={openCreate}>New secret</Button>
      </div>
      <div className="flex flex-col gap-2 text-muted-foreground text-sm">
        <p>
          A secret's value is encrypted and never shown again. You can only
          replace it.
        </p>
        <p>
          Proxy: the platform adds the secret as a header to requests to the
          hosts you list, so the agent's code never sees it. Env: the secret is
          set as an environment variable where the agent runs.
        </p>
        <p>
          An agent gets a secret only when you grant it on the agent's own page,
          in its Secrets tab.
        </p>
      </div>
      <SecretsTable
        onDelete={openDelete}
        onEditRules={openRules}
        onReplace={openReplace}
        secrets={secrets}
      />
      {active?.kind === "create" ? (
        <CreateSecretDialog onClose={close} onDone={done} />
      ) : null}
      {active?.kind === "replace" ? (
        <ReplaceValueDialog
          onClose={close}
          onDone={done}
          secret={active.secret}
        />
      ) : null}
      {active?.kind === "rules" ? (
        <EditRulesDialog onClose={close} onDone={done} secret={active.secret} />
      ) : null}
      {active?.kind === "delete" ? (
        <DeleteSecretDialog
          onClose={close}
          onDone={done}
          secret={active.secret}
        />
      ) : null}
    </section>
  );
}
