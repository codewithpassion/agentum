import { Show, UserButton } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";

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
        />
      </Show>
      <Show when="signed-out">
        <Link className="nav-link" to="/login">
          Sign in
        </Link>
      </Show>
    </>
  );
}
