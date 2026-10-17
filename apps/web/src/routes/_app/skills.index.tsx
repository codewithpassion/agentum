import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/skills/")({
  component: SkillsIndex,
});

function SkillsIndex() {
  return <section className="mx-auto max-w-5xl" />;
}
