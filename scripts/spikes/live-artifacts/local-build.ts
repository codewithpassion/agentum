import { readFileSync } from "node:fs";

let pid = process.ppid;
let allowed = false;
while (pid > 1) {
  const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  if (args.some((arg) => arg.endsWith("wrangler-dist/cli.js"))) {
    allowed =
      args.includes("dev") &&
      args.includes("--local") &&
      !args.includes("--remote");
    break;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  pid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
}
if (!allowed) {
  throw new Error("This fixture only permits wrangler dev --local");
}
