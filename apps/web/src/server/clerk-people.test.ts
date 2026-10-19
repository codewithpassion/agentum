import { describe, expect, test } from "bun:test";
import { toPersonName } from "./clerk-people.ts";

const user = (
  overrides: Partial<Parameters<typeof toPersonName>[0]> = {}
): Parameters<typeof toPersonName>[0] => ({
  emailAddresses: [
    { emailAddress: "first@example.com", id: "idn_1" },
    { emailAddress: "primary@example.com", id: "idn_2" },
  ],
  firstName: "Ada",
  lastName: "Lovelace",
  primaryEmailAddressId: "idn_2",
  ...overrides,
});

describe("toPersonName", () => {
  test("joins first and last name and takes the primary email", () => {
    expect(toPersonName(user())).toEqual({
      email: "primary@example.com",
      name: "Ada Lovelace",
    });
  });

  test("uses only the first name when there is no last name", () => {
    expect(toPersonName(user({ lastName: null }))).toEqual({
      email: "primary@example.com",
      name: "Ada",
    });
  });

  test("gives a null name and the primary email when there is no name at all", () => {
    expect(toPersonName(user({ firstName: null, lastName: null }))).toEqual({
      email: "primary@example.com",
      name: null,
    });
  });

  test("treats blank names as missing and trims the rest", () => {
    expect(
      toPersonName(user({ firstName: "  ", lastName: " Lovelace " }))
    ).toEqual({ email: "primary@example.com", name: "Lovelace" });
  });

  test("falls back to the first address when the primary id matches none", () => {
    expect(
      toPersonName(user({ primaryEmailAddressId: "idn_missing" }))
    ).toEqual({ email: "first@example.com", name: "Ada Lovelace" });
  });

  test("gives a null email when the user has no addresses", () => {
    expect(
      toPersonName(user({ emailAddresses: [], primaryEmailAddressId: null }))
    ).toEqual({ email: null, name: "Ada Lovelace" });
  });
});
