/**
 * The daemon's entry point: read the environment, make the root real, then hand
 * the shared handlers to whichever transport the mode asks for.
 */

import { prepareRoot, readConfig } from "./config";
import { startConnectClient } from "./connect";
import { createHandlers } from "./handlers";
import { startListenServer } from "./listen";
import { log } from "./log";
import { VERSION } from "./version";

const config = readConfig();
const root = await prepareRoot(config.root);
const handle = createHandlers({ execMaxMs: config.execMaxMs, root });

log(`v${VERSION} starting in ${config.mode} mode, root ${root}`);

if (config.mode === "listen") {
  const server = startListenServer({
    handle,
    port: config.port,
    tokenHash: config.tokenHash,
  });
  log(`listening on port ${server.port}`);
} else {
  startConnectClient({
    handle,
    token: config.agentumToken,
    url: config.agentumUrl,
  });
}
