import type { RailSetupStep } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "#/components/ui/button.tsx";

export const SETUP_CONTENT: Record<
  RailSetupStep,
  { action: string; body: string; title: string; to: string }
> = {
  ai_account: {
    action: "Paste an Anthropic key",
    body: "Agents run on your own account with Anthropic or OpenRouter, so you pay them directly. Paste a key and you're done.",
    title: "Add your AI account",
    to: "/settings/model-providers",
  },
  first_agent: {
    action: "Open the agent builder",
    body: "Say what you want taken off your plate. You'll see a draft and try it before anything goes live.",
    title: "Describe your first job",
    to: "/agents/new",
  },
};

/** One setup step: a short explanation and the button that does it. */
export function SetupPane({ step }: { step: RailSetupStep }) {
  const content = SETUP_CONTENT[step];
  return (
    <article className="flex flex-col gap-3" data-testid="setup-pane">
      <h1 className="font-heading text-3xl text-foreground">{content.title}</h1>
      <p className="text-muted-foreground">{content.body}</p>
      <div>
        <Link className={buttonVariants()} to={content.to}>
          {content.action}
        </Link>
      </div>
    </article>
  );
}
