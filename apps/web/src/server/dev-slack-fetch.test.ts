import { afterEach, expect, spyOn, test } from "bun:test";
import { devSlackFetch } from "./dev-slack-fetch.ts";

const FAKE = "http://localhost:5199";

let fetched: string[] = [];
const spy = spyOn(globalThis, "fetch").mockImplementation(((
  target: string | URL | Request
) => {
  fetched.push(target instanceof Request ? target.url : String(target));
  return Promise.resolve(new Response("{}"));
}) as typeof fetch);

afterEach(() => {
  fetched = [];
});

test("a dev build with a fake sends Slack's Web API calls to the fake", async () => {
  const fetcher = devSlackFetch({ base: `${FAKE}/`, dev: true });

  await fetcher?.("https://slack.com/api/chat.postMessage?x=1", {});
  await fetcher?.("https://example.com/other", {});

  expect(fetched).toEqual([
    `${FAKE}/api/chat.postMessage?x=1`,
    "https://example.com/other",
  ]);
});

test("a production build ignores the fake, and so does a dev build without one", () => {
  expect(devSlackFetch({ base: FAKE, dev: false })).toBeUndefined();
  expect(devSlackFetch({ base: undefined, dev: true })).toBeUndefined();
  expect(devSlackFetch({ base: "", dev: true })).toBeUndefined();
  spy.mockRestore();
});
