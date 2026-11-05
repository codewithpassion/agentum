import { dynamicAppRuntime } from "@repo/app-gateway/dynamic-app-runtime";
import type { AppHostProps, AppOutboundProps } from "@repo/app-gateway/types";
import type { AppReply } from "@repo/services/artifacts/replies";
import { appStorePort } from "../app-store/port.ts";
import type { Services } from "../compose.ts";
import { createAppGatewayPorts } from "./compose-ports.ts";

export interface AppWorkerExports {
  AppHost: (options: { props: AppHostProps }) => unknown;
  AppOutbound: (options: { props: AppOutboundProps }) => unknown;
}

export const appReplyInvoker =
  (env: Env, exports: AppWorkerExports, services: () => Services): AppReply =>
  async (host, message) => {
    const ports = createAppGatewayPorts({
      bucket: env.FILES,
      services: services(),
      store: appStorePort(env.APP_STORE),
    });
    const runtime = dynamicAppRuntime({
      hostStub: (props) => exports.AppHost({ props }),
      loader: env.LOADER,
      outboundStub: (props) => exports.AppOutbound({ props }) as Fetcher,
    });
    await runtime.reply({ bundle: ports.source.bundle, host, message });
  };
