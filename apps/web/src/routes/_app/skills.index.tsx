import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useMemo, useState } from "react";
import { ImportGithubForm } from "#/components/skills/import-github-form.tsx";
import { SkillNewForm } from "#/components/skills/skill-new-form.tsx";
import { SkillsList } from "#/components/skills/skills-list.tsx";
import { Button } from "#/components/ui/button.tsx";
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
  // On phones the list comes first and the three add forms wait behind one button.
  const [adding, setAdding] = useState(false);
  const toggleAdding = useCallback(() => setAdding((open) => !open), []);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="font-heading text-3xl text-foreground">Skills</h1>
      <Button
        aria-controls="skills-add-forms"
        aria-expanded={adding}
        className="md:hidden"
        data-testid="skills-add-toggle"
        onClick={toggleAdding}
        type="button"
        variant="outline"
      >
        {adding ? "Hide add skill" : "Add skill"}
      </Button>
      <div
        className={`${adding ? "flex" : "hidden"} flex-col gap-8 md:flex`}
        id="skills-add-forms"
      >
        <SkillNewForm onDone={refresh} />
        <ImportGithubForm onDone={refresh} />
      </div>
      <SkillsList
        agentNames={agentNames}
        assignments={assignments}
        proposals={proposals}
        skills={skills}
      />
    </section>
  );
}
