import { expect, test } from "bun:test";
import {
  ACCESS_TOKEN_PREFIX,
  connectionIdOfInvite,
  INVITE_TOKEN_PREFIX,
  isInviteToken,
  parseInviteLink,
} from "./urls.ts";

test("new access and invite tokens are issued with ag_", () => {
  expect(ACCESS_TOKEN_PREFIX).toBe("ag_a2a_");
  expect(INVITE_TOKEN_PREFIX).toBe("ag_inv_");
});

test("an invite token from before the rename, hm_inv_, still names its connection", () => {
  for (const prefix of ["ag_inv_", "hm_inv_"]) {
    const token = `${prefix}con_01ABC.secret-part`;
    expect(connectionIdOfInvite(token)).toBe("con_01ABC");
    expect(isInviteToken(token)).toBe(true);
    expect(
      parseInviteLink(`https://hm.example/connect/${token}`)?.inviteToken
    ).toBe(token);
  }
  expect(connectionIdOfInvite("xx_inv_con_01ABC.secret")).toBeNull();
  expect(isInviteToken("hm_a2a_con_01ABC.secret")).toBe(false);
});
