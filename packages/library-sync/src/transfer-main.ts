// The entry point of the library transfer script: `pull` or `push` from the command line.
import { runTransfer } from "./transfer.ts";

process.exitCode = await runTransfer({
  argv: process.argv.slice(2),
  env: process.env,
  log: (line) => console.log(line),
});
