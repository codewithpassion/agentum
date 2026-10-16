// Reads a request body up to a cap without buffering more than the cap.

export type BodyRead =
  | { bytes: Uint8Array<ArrayBuffer>; ok: true }
  | { error: string; ok: false; status: 400 | 413 };

class BodyTooLargeError extends Error {}

const DECIMAL = /^\d+$/;

/**
 * The body of `request`, or a refusal. A declared length over `max` is refused
 * unread, and a streamed body is cut off as soon as it passes `max`.
 */
export const readCappedBody = async (
  request: Pick<Request, "body" | "headers">,
  max: number
): Promise<BodyRead> => {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !DECIMAL.test(declared.trim())) {
    return { error: "invalid Content-Length", ok: false, status: 400 };
  }
  if (declared !== null && Number(declared) > max) {
    return { error: "body too large", ok: false, status: 413 };
  }
  if (!request.body) {
    return { bytes: new Uint8Array(), ok: true };
  }
  let seen = 0;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform: (chunk, controller) => {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new BodyTooLargeError("body too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
  try {
    return {
      bytes: new Uint8Array(await new Response(counted).arrayBuffer()),
      ok: true,
    };
  } catch (error: unknown) {
    if (seen > max) {
      return { error: "body too large", ok: false, status: 413 };
    }
    throw error;
  }
};
