import { Show, SignIn, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { clerkAppearance, PublicShell, SectionLabel } from "#/modules/landing";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  head: () => ({ meta: [{ title: "Sign in | Agentum" }] }),
});

function LoginPage() {
  return (
    <PublicShell
      homeHref="/"
      links={[{ href: "/", label: "Home", secondary: true }]}
    >
      <main className="df-auth">
        <section
          className="df-auth-panel"
          style={{ display: "grid", gap: "1.5rem" }}
        >
          <Show when="signed-out">
            <div
              className="df-center"
              style={{ display: "grid", gap: "0.75rem" }}
            >
              <SectionLabel>Access</SectionLabel>
              <h1 className="df-h2">Sign in to continue</h1>
            </div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <SignIn appearance={clerkAppearance} routing="hash" />
            </div>
            {import.meta.env.DEV ? (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <a className="df-dev-link" href="/api/dev-login">
                  Dev login (local only)
                </a>
              </div>
            ) : null}
          </Show>

          <Show when="signed-in">
            <SignedInGreeting />
          </Show>
        </section>
      </main>
    </PublicShell>
  );
}

function SignedInGreeting() {
  const { user } = useUser();
  if (!user) {
    return null;
  }

  const email = user.primaryEmailAddress?.emailAddress;

  return (
    <div className="df-center" style={{ display: "grid", gap: "1.5rem" }}>
      <div style={{ display: "grid", gap: "0.75rem" }}>
        <SectionLabel>Ready</SectionLabel>
        <h1 className="df-h2">Welcome back</h1>
        <p className="df-body">You're signed in as {email}</p>
      </div>
      <div>
        <a className="df-cta df-cta-orange" href="/">
          Open workspace →
        </a>
      </div>
    </div>
  );
}
