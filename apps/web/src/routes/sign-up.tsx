import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up")({
  component: SignUpPage,
});

function SignUpPage() {
  return (
    <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
      <SignUp routing="hash" />
    </main>
  );
}
