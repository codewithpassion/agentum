#!/usr/bin/env bun
// Copies every object of the old R2 bucket into the new one
// (docs/v3/agentum-v2-cutover.md). Dry run unless --apply. Usage, from apps/web:
//   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//     bun scripts/migrate-v2/r2.ts --env staging|production [--apply]
// R2 has no bucket-to-bucket copy and wrangler cannot list objects, so this
// goes through R2's S3 API with Bun's S3 client: no Worker to deploy and no
// extra package. Objects stream through this machine (1.2 GB in production
// on 3 Nov 2026). It copies only keys the new bucket lacks or holds at another
// size, so run it once before the maintenance window and again inside it.
// Keys and content types are kept; the app sets no other object metadata.
import { S3Client } from "bun";
import {
  extraKeys,
  NAMES,
  type ObjectEntry,
  parseMoveArgs,
  planCopy,
} from "./helpers.ts";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const PARALLEL = 8;

const client = (bucket: string): S3Client => {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!(ACCOUNT_ID && accessKeyId && secretAccessKey)) {
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with Object Read & Write on both buckets)."
    );
  }
  return new S3Client({
    accessKeyId,
    bucket,
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    secretAccessKey,
  });
};

const listAll = async (s3: S3Client): Promise<ObjectEntry[]> => {
  const entries: ObjectEntry[] = [];
  let startAfter: string | undefined;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each page names where the next starts
    const page = await s3.list({ maxKeys: 1000, startAfter });
    for (const item of page.contents ?? []) {
      entries.push({ key: item.key, size: item.size ?? 0 });
    }
    const last = page.contents?.at(-1)?.key;
    if (!(page.isTruncated && last)) {
      return entries;
    }
    startAfter = last;
  }
};

const copyOne = async (source: S3Client, target: S3Client, key: string) => {
  const from = source.file(key);
  const { type } = await from.stat();
  await target.write(key, from, { type });
};

const main = async () => {
  const { apply, env } = parseMoveArgs(process.argv.slice(2));
  const { oldBucket, newBucket } = NAMES[env];
  const source = client(oldBucket);
  const target = client(newBucket);
  const [have, want] = await Promise.all([listAll(target), listAll(source)]);
  const todo = planCopy(want, have);
  const bytes = todo.reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `${oldBucket}: ${want.length} objects. ${newBucket}: ${have.length}. To copy: ${todo.length} (${(bytes / 1e6).toFixed(1)} MB).`
  );
  const extra = extraKeys(want, have);
  if (extra.length > 0) {
    console.log(
      `${extra.length} keys exist only in ${newBucket} (left alone): ${extra.slice(0, 10).join(", ")}`
    );
  }
  if (!apply) {
    console.log("Dry run. --apply copies them.");
    return;
  }
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const entry = todo[next];
      next += 1;
      if (entry) {
        // biome-ignore lint/performance/noAwaitInLoops: a fixed pool of workers, each copying one object at a time
        await copyOne(source, target, entry.key);
        done += 1;
        if (done % 25 === 0 || done === todo.length) {
          console.log(`${done}/${todo.length}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const left = planCopy(want, await listAll(target));
  if (left.length > 0) {
    throw new Error(`${left.length} objects still differ: ${left[0]?.key}`);
  }
  console.log(
    `Copied ${todo.length} objects. ${newBucket} has every key of ${oldBucket}.`
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "r2 copy failed");
  process.exit(1);
}
