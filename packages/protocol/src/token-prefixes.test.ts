import { expect, test } from "bun:test";
import {
  claimResponseSchema,
  enrollRequestSchema,
  enrollResponseSchema,
} from "./machine.ts";
import {
  A2A_ACCESS_TOKEN,
  API_KEY,
  ENROLL_CODE,
  isPlatformToken,
  MACHINE_CREDENTIAL,
  RUN_TOKEN,
  SESSION_TOKEN,
} from "./token-prefixes.ts";

test("a kind knows both prefixes and matches, strips and finds either", () => {
  expect(API_KEY.accepted).toEqual(["ag_key_", "hm_key_"]);
  expect(API_KEY.matches("ag_key_abc")).toBe(true);
  expect(API_KEY.matches("hm_key_abc")).toBe(true);
  expect(API_KEY.matches("xx_key_abc")).toBe(false);
  expect(API_KEY.matches("ag_trg_abc")).toBe(false);
  expect(API_KEY.strip("hm_key_abc")).toBe("abc");
  expect(API_KEY.strip("ag_key_abc")).toBe("abc");
  expect(API_KEY.strip("abc")).toBeNull();
  expect(API_KEY.prefixOf("hm_key_abc")).toBe("hm_key_");
  expect(new RegExp(`^${A2A_ACCESS_TOKEN.pattern}x$`).test("hm_a2a_x")).toBe(
    true
  );
});

test("new tokens are issued with ag_, except the three installed daemons check", () => {
  expect(API_KEY.issue).toBe("ag_key_");
  expect(SESSION_TOKEN.issue).toBe("ag_ses_");
  expect(A2A_ACCESS_TOKEN.issue).toBe("ag_a2a_");
  // Flip these to ag_ once updated daemons and computer clients have shipped.
  expect(RUN_TOKEN.issue).toBe("hm_run_");
  expect(MACHINE_CREDENTIAL.issue).toBe("hm_mach_");
  expect(ENROLL_CODE.issue).toBe("hm_enr_");
});

test("isPlatformToken takes either namespace", () => {
  expect(isPlatformToken("ag_anything")).toBe(true);
  expect(isPlatformToken("hm_anything")).toBe(true);
  expect(isPlatformToken("sk-anything")).toBe(false);
});

test("the machine protocol takes both prefixes, so the daemon is ready for the flip", () => {
  for (const ns of ["ag_", "hm_"]) {
    expect(
      enrollRequestSchema.safeParse({ code: `${ns}enr_x`, singleUser: false })
        .success
    ).toBe(true);
    expect(
      enrollResponseSchema.safeParse({
        credential: `${ns}mach_x`,
        machineId: "m",
      }).success
    ).toBe(true);
    expect(
      claimResponseSchema.shape.runToken.safeParse(`${ns}run_x.y`).success
    ).toBe(true);
  }
  expect(
    enrollResponseSchema.safeParse({ credential: "xx_mach_x", machineId: "m" })
      .success
  ).toBe(false);
  expect(claimResponseSchema.shape.runToken.safeParse("xx_run_x").success).toBe(
    false
  );
});
