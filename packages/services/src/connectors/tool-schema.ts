import { z } from "zod";

/** The tools a connector's server listed, as stored in `connectors.tools`. */
export const toolSchema = z.array(
  z.object({
    description: z.string().nullable(),
    name: z.string(),
    readOnly: z.boolean().default(false),
  })
);
