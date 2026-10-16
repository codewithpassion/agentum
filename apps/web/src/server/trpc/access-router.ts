// Access lane tRPC procedures. The lane adds its routers here and nowhere else.

import { apiKeysRouter } from "./api-keys-router.ts";
import { router } from "./init.ts";

export const accessRouter = router({
  apiKeys: apiKeysRouter,
});
