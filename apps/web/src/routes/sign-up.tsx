import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { AuthPanel, clerkAppearance, PublicShell } from "#/modules/landing";

export const Route = createFileRoute("/sign-up")({
  component: SignUpPage,
  head: () => ({ meta: [{ title: "Sign up | Agentum" }] }),
});

const LINKS = [{ href: "/login", label: "Sign in", cta: true }];

function SignUpPage() {
  return (
    <PublicShell homeHref="/" links={LINKS}>
      <AuthPanel>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <SignUp appearance={clerkAppearance} routing="hash" />
        </div>
      </AuthPanel>
    </PublicShell>
  );
}
