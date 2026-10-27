import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let script = "";
for await (const chunk of process.stdin) {
  script += chunk;
}
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    compatibilityDate: "2026-08-19",
    modules: true,
    script,
  })
);
try {
  const response = await runtime.dispatchFetch("http://live-doc.test/");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  process.stdout.write(await response.text());
} finally {
  await runtime.dispose();
}
