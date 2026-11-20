import { expect, test } from "bun:test";
import { findSecret, neverEntryIn, outsideSourceOf } from "./guards";

// Sample secrets are built from pieces at runtime, so no real key is committed.

test("findSecret matches a PEM private key header", () => {
  const header = ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ");
  expect(findSecret(header)).toBe("PEM private key");
});

test("findSecret matches an AWS access key id", () => {
  const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  expect(findSecret(`key id ${key}`)).toBe("AWS access key id");
});

test("findSecret matches GitHub classic and fine-grained tokens", () => {
  const classic = ["ghp", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("_");
  const fineGrained = ["github_pat_", "FAKE0123456789ABCDEFGHIJKLMN"].join("");
  expect(findSecret(classic)).toBe("GitHub token");
  expect(findSecret(fineGrained)).toBe("GitHub token");
});

test("findSecret matches a Slack token", () => {
  const token = ["xoxb", "1234567890", "1234567890123", "FakeTokenValue"].join(
    "-"
  );
  expect(findSecret(token)).toBe("Slack token");
});

test("findSecret matches Stripe live and test keys", () => {
  const live = ["sk", "live", "FAKEFAKEFAKEFAKE1234"].join("_");
  const testKey = ["sk", "test", "FAKEFAKEFAKEFAKE1234"].join("_");
  expect(findSecret(live)).toBe("Stripe key");
  expect(findSecret(testKey)).toBe("Stripe key");
});

test("findSecret matches an sk- style API key", () => {
  const key = ["sk", "proj", "AbCdEf0123456789GhIjKl"].join("-");
  expect(findSecret(key)).toBe("sk- API key");
});

test("findSecret matches a Google API key", () => {
  const key = ["AIza", "SyD-0123456789abcdefghijklmnopqrstu"].join("");
  expect(findSecret(key)).toBe("Google API key");
});

test("findSecret matches a JSON web token", () => {
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ].join(".");
  expect(findSecret(jwt)).toBe("JSON web token");
});

test("findSecret matches Agentum tokens under both namespaces", () => {
  const current = ["ag", "a2a", "x9Kq2LmP8vR4tYw1ZcBn7Hs3Df6Gj0Ke"].join("_");
  const legacy = ["hm", "run", "x9Kq2LmP8vR4tYw1ZcBn7Hs3Df6Gj0Ke"].join("_");
  expect(findSecret(current)).toBe("Agentum token");
  expect(findSecret(legacy)).toBe("Agentum token");
});

test("findSecret matches a Bearer token", () => {
  const header = ["Authorization: Bearer", "abcDEF123456ghiJKL7890mnop"].join(
    " "
  );
  expect(findSecret(header)).toBe("Bearer token");
});

test("findSecret matches a password assignment", () => {
  expect(findSecret("Wifi password is Blue-Heron-42")).toBe(
    "password assignment"
  );
  expect(findSecret("db_passwd=hunter2hunter2")).toBe("password assignment");
});

test("findSecret matches a secret assignment", () => {
  const assignment = ["The api key is", "ab12CD34ef56GH78"].join(" ");
  expect(findSecret(assignment)).toBe("secret assignment");
  expect(findSecret("client_secret: aB3-dE5_fG7.hI9+jK1=")).toBe(
    "secret assignment"
  );
});

test("findSecret matches a Luhn-valid card number in every layout", () => {
  const layouts = [
    "4242 4242 4242 4242",
    "4242-4242-4242-4242",
    "4242424242424242",
  ];
  for (const layout of layouts) {
    expect(findSecret(`card ${layout}`)).toBe("card number");
  }
});

test("findSecret skips a 16 digit run that fails the Luhn check", () => {
  expect(findSecret("card 4242 4242 4242 4241")).toBeNull();
});

test("findSecret finds a valid card after an invalid digit run", () => {
  expect(findSecret("ref 1234567890123 card 4242 4242 4242 4242")).toBe(
    "card number"
  );
});

test("findSecret ignores plain notes", () => {
  const notes = [
    "Mia wants drafts as Google Docs, not attachments",
    "Call Tom on 0412 345 678",
    "Pipeline numbers live in the Sales sheet, tab Q4",
    "The token tracker lives in Notion",
    "Order 20261119 shipped",
  ];
  for (const note of notes) {
    expect(findSecret(note)).toBeNull();
  }
});

test("outsideSourceOf names peer for a2a origin or peer flag", () => {
  expect(outsideSourceOf({ origin: "a2a", peer: false, web: false })).toBe(
    "peer"
  );
  expect(outsideSourceOf({ origin: "ui", peer: true, web: false })).toBe(
    "peer"
  );
});

test("outsideSourceOf names mail for mail origin", () => {
  expect(outsideSourceOf({ origin: "mail", peer: false, web: false })).toBe(
    "mail"
  );
});

test("outsideSourceOf names web for a web flag", () => {
  expect(outsideSourceOf({ origin: null, peer: false, web: true })).toBe("web");
});

test("outsideSourceOf prefers peer, then mail, then web", () => {
  expect(outsideSourceOf({ origin: "mail", peer: true, web: true })).toBe(
    "peer"
  );
  expect(outsideSourceOf({ origin: "mail", peer: false, web: true })).toBe(
    "mail"
  );
});

test("outsideSourceOf is null for internal origins", () => {
  const origins = [
    "ui",
    "slack",
    "inbox",
    "qa",
    "routine",
    "trigger",
    "mcp",
    "artifact",
  ];
  for (const origin of origins) {
    expect(outsideSourceOf({ origin, peer: false, web: false })).toBeNull();
  }
});

test("neverEntryIn matches ignoring case and punctuation", () => {
  expect(neverEntryIn("Tom's SALARY is up", ["Salary"])).toBe("Salary");
});

test("neverEntryIn matches any term of an entry split on commas", () => {
  expect(neverEntryIn("Her bonus was paid", ["Salary, bonus"])).toBe(
    "Salary, bonus"
  );
  expect(neverEntryIn("the medical file", ["Dental; medical"])).toBe(
    "Dental; medical"
  );
  expect(neverEntryIn("the medical file", ["Dental/medical"])).toBe(
    "Dental/medical"
  );
  expect(neverEntryIn("the medical file", ["Dental\nmedical"])).toBe(
    "Dental\nmedical"
  );
});

test("neverEntryIn does not split an entry on and or or", () => {
  expect(neverEntryIn("Tom's salary is up", ["Salary and bonus"])).toBeNull();
});

test("neverEntryIn tolerates a plural in either direction", () => {
  expect(neverEntryIn("Her passwords are in the vault", ["Password"])).toBe(
    "Password"
  );
  expect(neverEntryIn("the password is old", ["Passwords"])).toBe("Passwords");
});

test("neverEntryIn matches a multi-word entry only in order and as whole words", () => {
  expect(
    neverEntryIn("Her health details are private", ["Health details"])
  ).toBe("Health details");
  expect(neverEntryIn("details of health", ["Health details"])).toBeNull();
  expect(neverEntryIn("health", ["Health details"])).toBeNull();
});

test("neverEntryIn does not match a partial word", () => {
  expect(neverEntryIn("my monkey and keyboard", ["key"])).toBeNull();
  expect(neverEntryIn("the payment is due", ["pay"])).toBeNull();
  expect(neverEntryIn("the key is here", ["key"])).toBe("key");
});

test("neverEntryIn returns null for an empty list or entries with no usable term", () => {
  expect(neverEntryIn("Salary", [])).toBeNull();
  expect(neverEntryIn("Salary", ["", "   ", " ,; / "])).toBeNull();
  expect(neverEntryIn("", ["Salary"])).toBeNull();
});

test("neverEntryIn returns the trimmed entry and the first entry that matches", () => {
  expect(neverEntryIn("salary", ["   Salary  "])).toBe("Salary");
  expect(
    neverEntryIn("Salary and health details", ["Health details", "Salary"])
  ).toBe("Health details");
});

test("neverEntryIn matches non-ASCII words", () => {
  expect(neverEntryIn("Mein Gehalt steigt", ["Gehalt"])).toBe("Gehalt");
  expect(neverEntryIn("Das Café ist offen", ["café"])).toBe("café");
  expect(neverEntryIn("Das Cafe\u0301 ist offen", ["Café"])).toBe("Café");
});
