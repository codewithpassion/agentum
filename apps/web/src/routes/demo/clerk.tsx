import { Show, SignIn, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/demo/clerk")({
  component: ClerkDemo,
});

function ClerkDemo() {
  return (
    <main className="demo-page demo-center">
      <section className="demo-panel w-full max-w-md space-y-6">
        <Show when="signed-out">
          <div className="space-y-1.5">
            <p className="island-kicker mb-2">Clerk</p>
            <h1 className="demo-title">Sign in to continue</h1>
            <p className="demo-muted text-sm">
              Clerk renders the sign-in UI, manages sessions, and handles social
              providers for you.
            </p>
          </div>
          <div className="flex justify-center pt-2">
            <SignIn routing="hash" />
          </div>
          <p className="demo-muted text-center text-xs">
            Built with{" "}
            <a
              className="font-medium"
              href="https://clerk.com"
              rel="noopener noreferrer"
              target="_blank"
            >
              CLERK
            </a>
            .
          </p>
        </Show>

        <Show when="signed-in">
          <SignedInGreeting />
        </Show>
      </section>
    </main>
  );
}

function SignedInGreeting() {
  const { user } = useUser();
  if (!user) {
    return null;
  }

  const email = user.primaryEmailAddress?.emailAddress;
  const initial = (user.firstName || email || "U").charAt(0).toUpperCase();

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <p className="island-kicker mb-2">Clerk</p>
        <h1 className="demo-title">Welcome back</h1>
        <p className="demo-muted text-sm">You're signed in as {email}</p>
      </div>

      <div className="flex items-center gap-3">
        {user.imageUrl ? (
          <img
            alt=""
            className="h-10 w-10 rounded-full"
            height={40}
            src={user.imageUrl}
            width={40}
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-800">
            <span className="font-medium text-neutral-600 text-sm dark:text-neutral-400">
              {initial}
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">
            {user.firstName} {user.lastName}
          </p>
          <p className="truncate text-neutral-500 text-xs dark:text-neutral-400">
            {email}
          </p>
        </div>
      </div>

      <p className="demo-muted text-center text-xs">
        Manage your account from the avatar in the header. Built with{" "}
        <a
          className="font-medium"
          href="https://clerk.com"
          rel="noopener noreferrer"
          target="_blank"
        >
          CLERK
        </a>
        .
      </p>
    </div>
  );
}
