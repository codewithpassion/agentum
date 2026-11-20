// A dev build can point Slack's Web API at a local fake (`scripts/dev/fake-slack.ts`),
// so a walkthrough sends nothing to slack.com. It is off unless the build is a dev
// build and `VITE_FAKE_SLACK_URL` names the fake, so a deployed Worker never reads it.
import type { Fetcher } from "@repo/services/connectors/mcp";

const SLACK_API = "https://slack.com/api/";
const TRAILING_SLASHES = /\/+$/;

// Outside Vite (a Node or Miniflare runner that bundles the app) there is no
// `import.meta.env`, so it is read through a cast that allows undefined.
const viteEnv = import.meta.env as
  | Record<string, string | undefined>
  | undefined;

/** `VITE_FAKE_SLACK_URL` from the build's environment, when there is one. */
export const fakeSlackUrl = (): string | undefined =>
  viteEnv?.VITE_FAKE_SLACK_URL;

export const devSlackFetch = (input: {
  base: string | undefined;
  dev: boolean;
}): Fetcher | undefined => {
  const { base, dev } = input;
  if (!(dev && base)) {
    return;
  }
  const root = base.replace(TRAILING_SLASHES, "");
  // A bare `fetch` loses its receiver in workerd ("Illegal invocation").
  return (target, init) => {
    const address = target instanceof Request ? target.url : String(target);
    return address.startsWith(SLACK_API)
      ? fetch(`${root}/api/${address.slice(SLACK_API.length)}`, init)
      : fetch(target, init);
  };
};
