import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { DeleteSkillDialog } from "#/components/skills/delete-skill-dialog";
import { SkillEditor } from "#/components/skills/skill-editor";
import { SkillHistory } from "#/components/skills/skill-history";
import {
  SkillSourceLine,
  SkillUpdateNotice,
} from "#/components/skills/skill-source";
import {
  ownerLabel,
  statusLabel,
  versionLabel,
} from "#/components/skills/skills-logic";
import { Badge } from "#/components/ui/badge";
import { Button, buttonVariants } from "#/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";

const TABS = ["files", "history"] as const;

const searchSchema = z.object({
  review: z.number().int().positive().optional().catch(undefined),
  tab: z.enum(TABS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/skills/$skillId")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) => {
    try {
      const trpc = getTrpc();
      const [skills, versions, agents] = await Promise.all([
        trpc.skillStore.list.query(),
        trpc.skillStore.log.query({ skillId: params.skillId }),
        trpc.agents.list.query({ includeArchived: true }),
      ]);
      const skill = skills.find((entry) => entry.id === params.skillId);
      if (!skill) {
        throw notFound();
      }
      return { agents, skill, versions };
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "NOT_FOUND"
      ) {
        throw notFound();
      }
      throw error;
    }
  },
  notFoundComponent: SkillNotFound,
  component: SkillPage,
});

function SkillNotFound() {
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-4">
      <p className="text-muted-foreground text-sm">Skill not found.</p>
      <Link className={buttonVariants({ variant: "outline" })} to="/skills">
        Back to skills
      </Link>
    </section>
  );
}

function SkillPage() {
  const { agents, skill, versions } = Route.useLoaderData();
  const { review, tab = "files" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const openDelete = useCallback(() => setDeleting(true), []);
  const closeDelete = useCallback(() => setDeleting(false), []);
  const deleted = useCallback(() => navigate({ to: "/skills" }), [navigate]);

  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents]
  );
  const refresh = useCallback(() => router.invalidate(), [router]);
  const proposed = useCallback(
    async (version: number) => {
      await router.invalidate();
      return navigate({ search: { review: version, tab: "history" } });
    },
    [navigate, router]
  );
  const selectTab = useCallback(
    (next: string) => {
      const parsed = searchSchema.parse({ tab: next });
      return navigate({ search: { tab: parsed.tab } });
    },
    [navigate]
  );

  const head = versions.find(
    (version) => version.number === skill.latestVersion
  );

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          className="pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center text-muted-foreground text-sm hover:text-foreground"
          to="/skills"
        >
          All skills
        </Link>
        <h1 className="font-heading text-3xl text-foreground">{skill.name}</h1>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
          <span data-testid="skill-owner">
            Owner: {ownerLabel(skill.ownerAgentId, agentNames)}
          </span>
          <span>
            {skill.latestApprovedVersion === null
              ? "No approved version yet"
              : `Latest approved ${versionLabel(skill.latestApprovedVersion)}`}
          </span>
        </p>
        {skill.source ? <SkillSourceLine source={skill.source} /> : null}
        <div>
          <Button
            data-testid="skill-delete"
            onClick={openDelete}
            size="sm"
            type="button"
            variant="destructive"
          >
            Delete
          </Button>
        </div>
        {deleting ? (
          <DeleteSkillDialog
            onClose={closeDelete}
            onDone={deleted}
            skill={skill}
          />
        ) : null}
      </header>
      {head === undefined || head.status !== "proposed" ? null : (
        <p
          className="rounded-lg border border-border bg-muted p-3 text-sm"
          data-testid="skill-head-pending"
        >
          <Badge variant="secondary">{statusLabel(head.status)}</Badge> Version{" "}
          {head.number} is waiting for review in History. A commit here builds
          on it.
        </p>
      )}
      {skill.source ? (
        <SkillUpdateNotice
          onProposed={proposed}
          skillId={skill.id}
          source={skill.source}
        />
      ) : null}
      <Tabs onValueChange={selectTab} value={tab}>
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent className="pt-6" value="files">
          {skill.latestVersion === null ? (
            <p className="text-muted-foreground text-sm">No versions yet.</p>
          ) : (
            <SkillEditor
              baseVersion={skill.latestApprovedVersion ?? skill.latestVersion}
              onCommitted={refresh}
              skillId={skill.id}
            />
          )}
        </TabsContent>
        <TabsContent className="pt-6" value="history">
          <SkillHistory
            agentNames={agentNames}
            key={skill.id}
            onChanged={refresh}
            reviewVersion={review}
            skill={skill}
            versions={versions}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
