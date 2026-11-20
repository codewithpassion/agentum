import { Show, UserButton } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";

export default function HeaderUser() {
  return (
    <>
      <Show when="signed-in">
        <UserButton
          appearance={{
            elements: {
              userButtonTrigger: { minHeight: "40px", minWidth: "40px" },
            },
          }}
        >
          <UserButton.MenuItems>
            <UserButton.Link
              href="/settings/sign-ins"
              label="Your sign-ins"
              labelIcon={<KeyRound className="size-4" />}
            />
          </UserButton.MenuItems>
        </UserButton>
      </Show>
      <Show when="signed-out">
        <Link className="nav-link" to="/login">
          Sign in
        </Link>
      </Show>
    </>
  );
}
