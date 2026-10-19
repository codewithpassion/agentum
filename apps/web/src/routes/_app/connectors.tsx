import { createFileRoute, redirect } from "@tanstack/react-router";
import { connectSearchSchema } from "#/components/connectors/connect-search";

export const Route = createFileRoute("/_app/connectors")({
  validateSearch: (search) => connectSearchSchema.parse(search),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/connectors", search });
  },
});
