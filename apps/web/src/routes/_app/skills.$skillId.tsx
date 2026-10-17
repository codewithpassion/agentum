import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/skills/$skillId")({
  component: SkillPage,
});

function SkillPage() {
  return <section className="mx-auto max-w-5xl" />;
}
