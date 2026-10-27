import { expect, test } from "bun:test";
import { ARTIFACT_VIEW_OUTCOMES } from "@repo/db/shared";
import {
  describeBrowser,
  describeLink,
  describeNetwork,
  describePlace,
  describeWho,
  OUTCOME_LABELS,
  outcomeTone,
} from "./access-log-model.ts";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

test("every outcome has a label and a tone", () => {
  for (const outcome of ARTIFACT_VIEW_OUTCOMES) {
    expect(OUTCOME_LABELS[outcome].length).toBeGreaterThan(0);
  }
  expect(OUTCOME_LABELS.revoked).toBe("Link revoked");
  expect(outcomeTone("ok")).toBe("ok");
  expect(outcomeTone("revoked")).toBe("warn");
  expect(outcomeTone("error")).toBe("bad");
});

test("place skips missing parts", () => {
  expect(describePlace({ city: "Sydney", country: "AU", region: "NSW" })).toBe(
    "Sydney, NSW, AU"
  );
  expect(describePlace({ city: null, country: "AU", region: null })).toBe("AU");
  expect(describePlace({ city: null, country: null, region: null })).toBe(
    "Unknown"
  );
});

test("network shows the name and the prefix, never more", () => {
  expect(
    describeNetwork({
      asn: "1221",
      asOrg: "Telstra",
      ipPrefix: "203.0.113.0/24",
    })
  ).toBe("Telstra (203.0.113.0/24)");
  expect(describeNetwork({ asn: "1221", asOrg: null, ipPrefix: null })).toBe(
    "AS1221"
  );
  expect(describeNetwork({ asn: "AS1221", asOrg: null, ipPrefix: null })).toBe(
    "AS1221"
  );
  expect(
    describeNetwork({ asn: null, asOrg: null, ipPrefix: "2001:db8::/48" })
  ).toBe("2001:db8::/48");
  expect(describeNetwork({ asn: null, asOrg: null, ipPrefix: null })).toBe(
    "Unknown"
  );
});

test("browser and system come from the agent string", () => {
  expect(describeBrowser(CHROME_MAC)).toBe("Chrome on macOS");
  expect(describeBrowser(EDGE_WIN)).toBe("Edge on Windows");
  expect(describeBrowser(SAFARI_IOS)).toBe("Safari on iOS");
  expect(describeBrowser(FIREFOX_LINUX)).toBe("Firefox on Linux");
  expect(describeBrowser(null)).toBe("Unknown browser");
  expect(describeBrowser("curl/8.0")).toBe("Unknown browser");
});

test("who names the link or the member", () => {
  const shares = [{ createdAt: "2026-10-26T10:00:00.000Z", id: "s1" }];
  expect(
    describeWho({ shareId: "s1", surface: "share", userId: null }, shares)
  ).toStartWith("Link created ");
  expect(
    describeWho({ shareId: "gone", surface: "share", userId: null }, shares)
  ).toBe("Link (removed)");
  expect(
    describeWho({ shareId: null, surface: "viewer", userId: "u1" }, shares)
  ).toBe("Member, in viewer");
  expect(
    describeWho({ shareId: null, surface: "test", userId: null }, shares)
  ).toBe("Unknown");
});

test("the filter label marks links that are not active", () => {
  const active = describeLink({
    createdAt: "2026-10-26T10:00:00.000Z",
    status: "active",
  });
  expect(active).not.toContain("(");
  expect(
    describeLink({ createdAt: "2026-10-26T10:00:00.000Z", status: "revoked" })
  ).toEndWith("(revoked)");
});
