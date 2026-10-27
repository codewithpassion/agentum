import {
  cutUserAgent,
  referrerHost,
  truncateIp,
} from "@repo/services/artifacts/view-privacy";
import type { GuestOpenMetadata } from "@repo/services/live-guests/sessions";
export const guestOpenMetadata = (request: Request): GuestOpenMetadata => {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const text = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 256) || undefined : undefined;
  return {
    asn: typeof cf.asn === "number" ? String(cf.asn) : undefined,
    asOrg: text(cf.asOrganization),
    city: text(cf.city),
    country: text(cf.country),
    ipPrefix:
      truncateIp(request.headers.get("CF-Connecting-IP") ?? "") ?? undefined,
    referrerHost: referrerHost(request.headers.get("Referer")) ?? undefined,
    region: text(cf.region),
    userAgent: cutUserAgent(request.headers.get("User-Agent")) ?? undefined,
  };
};
