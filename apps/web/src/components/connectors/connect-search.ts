import { z } from "zod";

export const connectSearchSchema = z.object({
  // The router parses a bare `1` in the query into a number.
  connect_error: z.union([z.string(), z.number()]).optional().catch(undefined),
  connected: z.union([z.string(), z.number()]).optional().catch(undefined),
});
