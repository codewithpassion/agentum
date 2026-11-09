import { useAuth } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";

/** A secret is repaired in Authentication; it never needs a member's login. */
export function SecretNotice({ connectorId }: { connectorId: string }) {
  const { orgRole } = useAuth();
  return (
    <span className="text-muted-foreground text-xs">
      Needs a secret.{" "}
      {orgRole === "org:admin" ? (
        <Link search={{ auth: connectorId }} to="/settings/connectors">
          Open Authentication to link a secret.
        </Link>
      ) : (
        "Ask an admin to link one in the app."
      )}
    </span>
  );
}
