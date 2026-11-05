import { useClerk } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { MEMBER_PROFILE_APPEARANCE } from "#/components/rail/invite-logic";
import { SettingsIndex } from "#/components/settings/settings-index";

export const Route = createFileRoute("/_app/settings/")({
  component: SettingsIndexPage,
});

function SettingsIndexPage() {
  const clerk = useClerk();
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      navigate({ to: "/settings/model-providers", replace: true });
    }
  }, [navigate]);
  const openMembers = useCallback(
    () =>
      clerk.openOrganizationProfile({ appearance: MEMBER_PROFILE_APPEARANCE }),
    [clerk]
  );
  return <SettingsIndex onMembers={openMembers} />;
}
