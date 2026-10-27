import {
  type ShareOpenResponse,
  shareOpenResponseSchema,
} from "@repo/protocol/artifacts";

export type ShareOpenResult =
  | { data: ShareOpenResponse; ok: true }
  | { ok: false };

/**
 * Opens a share link from the browser, so the open is logged (R1.28). Every
 * refusal, network failure or odd body comes back as `{ ok: false }`.
 */
export async function openShare(
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<ShareOpenResult> {
  try {
    const response = await fetchFn(
      `/api/share/${encodeURIComponent(token)}/open`,
      { method: "POST" }
    );
    if (response.status !== 200) {
      return { ok: false };
    }
    const parsed = shareOpenResponseSchema.safeParse(await response.json());
    return parsed.success ? { data: parsed.data, ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}
