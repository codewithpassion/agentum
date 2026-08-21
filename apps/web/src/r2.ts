/**
 * The one thing every module's cleanup needs from R2 and the binding does not
 * give it: a delete that survives a workspace with more objects in it than one
 * call may name.
 */

/** R2 refuses a `delete` naming more keys than this. */
const MAX_KEYS_PER_DELETE = 1000;

/**
 * Deletes every key, a batch at a time. Keys nothing has ever stored are not an
 * error - R2 deletes are idempotent - so a half-finished earlier sweep costs
 * nothing to repeat.
 */
export const deleteObjects = async (
  bucket: R2Bucket,
  keys: readonly string[]
): Promise<void> => {
  for (let start = 0; start < keys.length; start += MAX_KEYS_PER_DELETE) {
    // biome-ignore lint/performance/noAwaitInLoops: batches are paced, not fanned out at the bucket
    await bucket.delete([...keys.slice(start, start + MAX_KEYS_PER_DELETE)]);
  }
};
