import { createFileRoute } from "@tanstack/react-router";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { QuestionPage } from "#/components/qa/question-page";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const Route = createFileRoute("/_app/qa/$questionId")({
  loader: async ({ params }) =>
    loadOrLogin(async () => {
      const [view, agents, me] = await Promise.all([
        getTrpc().qa.get.query({ questionId: params.questionId }),
        getTrpc().agents.list.query({ includeArchived: true }),
        getTrpc().me.query(),
      ]);
      return { agentNames: agentNameMap(agents), userId: me.userId, view };
    }, ["NOT_FOUND"]),
  notFoundComponent: QuestionNotFound,
  component: QuestionRoute,
});

function QuestionRoute() {
  const { agentNames, userId, view } = Route.useLoaderData();
  return (
    <QuestionPage
      agentNames={agentNames}
      initial={view}
      key={view.question.id}
      userId={userId}
    />
  );
}

function QuestionNotFound() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">
        Question not found
      </h1>
      <p className="mt-4 text-muted-foreground text-sm">
        This question does not exist, or you cannot see it.
      </p>
    </section>
  );
}
