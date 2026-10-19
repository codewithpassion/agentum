import { expect, test } from "bun:test";
import { redactScript } from "./redact-script.ts";

test("blanks header values, keeping the header name", () => {
  const out = redactScript(
    `curl -s -H "Authorization: Bearer sk-live-1234567890abcdef" -H 'X-Api-Key: abc123' -H Cookie:session=zzz https://api.example.com/v1`
  );
  expect(out).toBe(
    `curl -s -H "Authorization: [redacted]" -H 'X-Api-Key: [redacted]' -H Cookie: [redacted] https://api.example.com/v1`
  );
});

test("blanks -u, cookie and data values in every spelling", () => {
  const out = redactScript(
    `curl -u alice:hunter2 --user=bob:pw -b "s=1" -d a=SECRET --data-raw '{"t":"SECRET"}' --data-urlencode=x=SECRET https://example.com/`
  );
  expect(out).not.toContain("hunter2");
  expect(out).not.toContain("bob:pw");
  expect(out).not.toContain("SECRET");
  expect(out).not.toContain('s=1"');
  expect(out).toContain("https://example.com/");
});

test("blanks the query string and the login of any URL", () => {
  const out = redactScript(
    "echo done; curl https://user:pw@api.example.com/v1/items?token=abc&page=2 | jq ."
  );
  expect(out).toBe(
    "echo done; curl https://[redacted]@api.example.com/v1/items?[redacted] | jq ."
  );
});

test("follows a backslash continuation", () => {
  const out = redactScript(
    `curl -X POST \\\n  -H "Authorization: Bearer abc" \\\n  -d 'k=v' \\\n  https://example.com/x`
  );
  expect(out).not.toContain("abc");
  expect(out).not.toContain("k=v");
  expect(out).toContain("https://example.com/x");
});

test("leaves other commands as typed, even with -d and -u", () => {
  const script = "cut -d, -f1 data.csv\nsort -u names.txt\ngrep -d skip x *";
  expect(redactScript(script)).toBe(script);
});
