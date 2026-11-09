import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/_app/assistant")({
  validateSearch: z.object({ c: z.string().min(1).max(200).optional() }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/desk",
      search: { assistant: search.c ?? "new" },
      replace: true,
    });
  },
});
