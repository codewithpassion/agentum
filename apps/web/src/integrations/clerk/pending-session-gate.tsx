import {
  RedirectToTasks,
  useClerk,
  useOrganizationList,
  useSession,
} from "@clerk/tanstack-react-start";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { soleOrganizationId } from "./sole-organization";

const CHOOSE_ORGANIZATION_PATH = "/choose-organization";

// A user who signs in with no active organisation gets a pending session with
// the `choose-organization` task, and the rest of the app treats that session
// as signed out. An Agent Task sign-in on the production instance ends up
// there. Nobody is at the keyboard to pick, so a user with exactly one
// organisation gets it activated here. Everyone else goes to the picker.
export function PendingSessionGate() {
  const { isLoaded, session } = useSession();
  if (
    isLoaded &&
    session?.status === "pending" &&
    session.currentTask?.key === "choose-organization"
  ) {
    return <ResolveChooseOrganization />;
  }
  return null;
}

function ResolveChooseOrganization() {
  const { pathname } = useLocation();
  const clerk = useClerk();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: true,
  });
  const started = useRef(false);
  const organizationId = soleOrganizationId(
    userMemberships.data,
    userMemberships.count
  );
  const onPicker = pathname === CHOOSE_ORGANIZATION_PATH;
  // While the list is fetching it reads as empty, which must not look like
  // "no organisation".
  const loading =
    !isLoaded || userMemberships.isLoading || userMemberships.isFetching;

  useEffect(() => {
    if (loading || !organizationId || started.current) {
      return;
    }
    started.current = true;
    // Read before setActive, which moves the page to the task URL itself.
    const target = onPicker ? "/" : window.location.href;
    setActive({ organization: organizationId })
      .then(() => {
        // setActive can resolve with the server still pending (it skips the
        // server call in an unfocused tab). Reloading then would loop, so the
        // session is left for the picker.
        if (clerk.session?.status !== "pending") {
          // A full load so the server sees the active organisation.
          window.location.assign(target);
        }
      })
      .catch(() => {
        if (!onPicker) {
          window.location.assign(CHOOSE_ORGANIZATION_PATH);
        }
      });
  }, [clerk, loading, onPicker, organizationId, setActive]);

  if (!(loading || organizationId || onPicker)) {
    return <RedirectToTasks />;
  }
  return null;
}
