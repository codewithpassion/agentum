import { createFileRoute } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/")({ component: App });

const features = [
  {
    title: "Type-safe routing",
    description: "Routes and links stay in sync across every page.",
  },
  {
    title: "Server functions",
    description:
      "Call server code from your UI without creating API boilerplate.",
  },
  {
    title: "Streaming by default",
    description:
      "Ship progressively rendered responses for faster experiences.",
  },
  {
    title: "Tailwind native",
    description:
      "Design quickly with utility-first styling and reusable tokens.",
  },
] as const;

function App() {
  return (
    <main className="page-wrap px-4 pt-14 pb-8">
      <section className="rise-in pt-6 pb-4 sm:pt-10">
        <p className="island-kicker mb-4">TanStack Start base template</p>
        <h1 className="display-title mb-5 max-w-3xl text-5xl text-foreground leading-[1.05] sm:text-6xl">
          Start simple, ship quickly.
        </h1>
        <p className="mb-8 max-w-2xl text-base text-muted-foreground sm:text-lg">
          This base starter intentionally keeps things light: two routes, clean
          structure, and the essentials you need to build from scratch.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <a href="/about">About this starter</a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://tanstack.com/router"
              rel="noopener noreferrer"
              target="_blank"
            >
              Router guide
            </a>
          </Button>
        </div>
      </section>

      <section className="mt-14 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {features.map(({ title, description }, index) => (
          <article
            className="rise-in border-border border-t pt-5"
            key={title}
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <p className="island-kicker mb-2">
              {String(index + 1).padStart(2, "0")}
            </p>
            <h2 className="mb-2 font-heading text-2xl text-foreground leading-tight">
              {title}
            </h2>
            <p className="m-0 text-muted-foreground text-sm">{description}</p>
          </article>
        ))}
      </section>

      <section className="island-shell mt-14 p-6 sm:p-8">
        <p className="island-kicker mb-3">Quick start</p>
        <ul className="m-0 list-disc space-y-2 pl-5 text-muted-foreground text-sm">
          <li>
            Edit <code>src/routes/index.tsx</code> to customize the home page.
          </li>
          <li>
            Update <code>src/components/Header.tsx</code> and{" "}
            <code>src/components/Footer.tsx</code> for brand links.
          </li>
          <li>
            Add routes in <code>src/routes</code> and tweak visual tokens in{" "}
            <code>src/styles.css</code>.
          </li>
        </ul>
      </section>
    </main>
  );
}
