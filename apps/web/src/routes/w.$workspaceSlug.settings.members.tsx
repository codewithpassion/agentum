import { createFileRoute } from "@tanstack/react-router";
import { MembersSettings } from "#/components/tenant/members-settings";

export const Route = createFileRoute("/w/$workspaceSlug/settings/members")({
  component: MembersSettings,
});
