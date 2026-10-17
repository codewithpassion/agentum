import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useMemo } from "react";
import { SkillNewForm } from "#/components/skills/skill-new-form.tsx";
import { SkillsList } from "#/components/skills/skills-list.tsx";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/skills/")({
  loader: async () => {
    try {
      const trpc = getTrpc();
      const [skills, assignments, proposals, agents] = await Promise.all([
        trpc.skillStore.list.query(),
        trpc.skillStore.assignments.query(),
        trpc.skillStore.proposals.query(),
        trpc.agents.list.query({ includeArchived: true }),
      ]);
      return { agents, assignments, proposals, skills };
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
  component: SkillsIndex,
});

function SkillsIndex() {
  const { agents, assignments, proposals, skills } = Route.useLoaderData();
  const router = useRouter();

  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents]
  );

  const refresh = useCallback(() => router.invalidate(), [router]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="font-heading text-3xl text-foreground">Skills</h1>
      <SkillNewForm onDone={refresh} />
      <SkillsList
        agentNames={agentNames}
        assignments={assignments}
        proposals={proposals}
        skills={skills}
      />
    </section>
  );
}
