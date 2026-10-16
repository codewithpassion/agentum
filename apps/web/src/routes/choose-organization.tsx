import { TaskChooseOrganization } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/choose-organization")({
  component: ChooseOrganizationPage,
});

// Where the provider's taskUrls send a user who signed in without an active
// organisation, so the step stays on the app's origin.
function ChooseOrganizationPage() {
  return (
    <main className="page-wrap flex min-h-[calc(100vh-13rem)] items-center justify-center px-4 py-12">
      <TaskChooseOrganization redirectUrlComplete="/" />
    </main>
  );
}
