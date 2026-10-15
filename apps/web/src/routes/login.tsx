import { Show, SignIn, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader } from "#/components/ui/card";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  return (
    <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <Show when="signed-out">
          <CardHeader>
            <p className="island-kicker mb-2">Clerk</p>
            <h1 className="display-title text-2xl sm:text-3xl">
              Sign in to continue
            </h1>
            <p className="text-muted-foreground text-sm">
              Clerk renders the sign-in UI, manages sessions, and handles social
              providers for you.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex justify-center pt-2">
              <SignIn routing="hash" />
            </div>
            {import.meta.env.DEV ? (
              <div className="flex justify-center">
                <Button asChild size="sm" variant="outline">
                  <a href="/api/dev-login">Dev login (local only)</a>
                </Button>
              </div>
            ) : null}
            <p className="text-center text-muted-foreground text-xs">
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
          </CardContent>
        </Show>

        <Show when="signed-in">
          <SignedInGreeting />
        </Show>
      </Card>
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
    <>
      <CardHeader>
        <p className="island-kicker mb-2">Clerk</p>
        <h1 className="display-title text-2xl sm:text-3xl">Welcome back</h1>
        <p className="text-muted-foreground text-sm">
          You're signed in as {email}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
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
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <span className="font-medium text-muted-foreground text-sm">
                {initial}
              </span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm">
              {user.firstName} {user.lastName}
            </p>
            <p className="truncate text-muted-foreground text-xs">{email}</p>
          </div>
        </div>

        <p className="text-center text-muted-foreground text-xs">
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
      </CardContent>
    </>
  );
}
