import { expect, test } from "bun:test";
import type { Payload } from "./payload.ts";
import { redactText, redactToolPayload } from "./scrub.ts";

const REDACTED = "[redacted]";
const MEGABYTE = 1_000_000;
const PERF_BUDGET_MS = 1500;
const REPEAT_HOSTILE = 500_000;
const REPEAT_JWT = 350_000;
const REPEAT_SK = 350_000;
const REPEAT_PASSWORD = 110_000;
const REPEAT_ESCAPED = 90_000;
const REPEAT_AUTH = 60_000;
const REPEAT_QUOTE = 140_000;
const REPEAT_QUOTED_HEADER = 80_000;
const REPEAT_KEY = 200_000;
const REPEAT_BEARER = 150_000;
const SENTENCE =
  "The build log shows every test passed and the deploy finished cleanly. ";
const SENTENCE_EVERY = 1000;
const TOOL_NAME = "Bash";
const TOOL_USE_ID = "toolu_01ABC";

type PayloadValue = Payload[string];

function fieldOf(value: PayloadValue | undefined, key: string): PayloadValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  const field = value[key];
  if (field === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return field;
}

function textOf(value: PayloadValue): string {
  if (typeof value !== "string") {
    throw new Error("expected a string");
  }
  return value;
}

function scrubInput(command: string): string {
  const scrubbed = redactToolPayload({
    input: { command },
    name: TOOL_NAME,
    toolUseId: TOOL_USE_ID,
  });
  return textOf(fieldOf(fieldOf(scrubbed, "input"), "command"));
}

function scrubOutput(output: string): string {
  const scrubbed = redactToolPayload({
    ok: true,
    output,
    toolUseId: TOOL_USE_ID,
  });
  return textOf(fieldOf(scrubbed, "output"));
}

function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

test.each([
  [
    'curl -H "x-api-key: sk-test-1234567890abcdef" https://example.com',
    'curl -H "x-api-key: [redacted]" https://example.com',
  ],
  ['{"password": "hunter2hunter2"}', '{"password": "[redacted]"}'],
  ["token=abc123&x=1", "token=[redacted]"],
  ["Cookie: a=1; b=2", "Cookie: [redacted]"],
  ["Authorization: Bearer abc.def.ghi-jklmnop", "Authorization: [redacted]"],
  ['"Authorization": "Bearer abcdefgh"', '"Authorization": "[redacted]"'],
  [
    "Proxy-Authorization: Basic dXNlcjpwYXNz",
    "Proxy-Authorization: [redacted]",
  ],
  ["Authorization: Token t0k3nvalue", "Authorization: [redacted]"],
  [
    "Authorization: Digest username=bob, response=abcdefgh",
    "Authorization: [redacted]",
  ],
  ["X-Api-Key: abc123def456", "X-Api-Key: [redacted]"],
  ["--password=hunter2", "--password=[redacted]"],
  ["password=value&x=1", "password=[redacted]"],
  ["api_key=abc123", "api_key=[redacted]"],
  ["api-key: abc123", "api-key: [redacted]"],
  ["apikey=abc123", "apikey=[redacted]"],
  ["access_token=abc123", "access_token=[redacted]"],
  ["GITHUB_TOKEN=abc123", "GITHUB_TOKEN=[redacted]"],
  ["client_secret: xyz789", "client_secret: [redacted]"],
  ["passwd=abc123", "passwd=[redacted]"],
  ['"Cookie": "a=1; b=2"', '"Cookie": "[redacted]"'],
  ["'password': 'hunter2'", "'password': '[redacted]'"],
  ["password=[redacted]", "password=[redacted]"],
  ["token: [secret:abc123]", "token: [secret:abc123]"],
  ["token:\nnext line", "token:\nnext line"],
])("redacts credential fields written as text: %s", (input, expected) => {
  expect(redactText(input)).toBe(expected);
  expect(scrubInput(input)).toBe(expected);
  expect(scrubOutput(input)).toBe(expected);
});

test.each([
  [
    'curl -d "{\\"password\\":\\"hunter2\\",\\"api_key\\":\\"abc123xyz\\"}" https://example.com',
    'curl -d "{\\"password\\":\\"[redacted]\\",\\"api_key\\":\\"[redacted]\\"}" https://example.com',
  ],
  ["Authorization: Bot MTIzNDU2Nzg5.abc", "Authorization: [redacted]"],
  ["Authorization: ApiKey k-12345", "Authorization: [redacted]"],
  ["Authorization: SSWS 00abcDEF", "Authorization: [redacted]"],
  ["Authorization: rawtokenvalue", "Authorization: [redacted]"],
  ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "AWS_SECRET_ACCESS_KEY=[redacted]"],
  ["secret_key: abc123", "secret_key: [redacted]"],
  ["ASIAPACIFICREGIONSERVERS", "ASIAPACIFICREGIONSERVERS"],
  ["AKIAIOSFODNN7EXAMPLE", "[redacted]"],
  ["Authorization: abc123secret (expired)", "Authorization: [redacted]"],
  ['Authorization: "rawsecret more"', 'Authorization: "[redacted]"'],
  [
    '-H "Authorization: Foo abc123" https://x',
    '-H "Authorization: [redacted]" https://x',
  ],
  ["token=abc123 [secret:GH]", "token=[redacted]"],
  ["password: hunter2 [redacted]", "password: [redacted]"],
  ["password: Bearer [redacted]", "password: [redacted]"],
  [
    '{\\"password\\":\\"\\",\\"api_key\\":\\"s3cr3t\\"}',
    '{\\"password\\":\\"\\",\\"api_key\\":\\"[redacted]\\"}',
  ],
])(
  "redacts a shell-escaped body, any auth scheme and AWS names: %s",
  (input, expected) => {
    expect(redactText(input)).toBe(expected);
  }
);

test.each([
  // Review 3: a known scheme followed by quoted, escaped or parameterised text.
  ['Authorization: Bearer "abc def"', "Authorization: [redacted]"],
  [
    '-H "Authorization: Bearer \\"abcsecret\\"" https://x',
    '-H "Authorization: [redacted]" https://x',
  ],
  ['Authorization: Token token="abcsecret"', "Authorization: [redacted]"],
  [
    'Authorization: OAuth oauth_token="abc", oauth_signature="sigsecret"',
    "Authorization: [redacted]",
  ],
  ["Authorization: Bearer abc;secret2,more)tail", "Authorization: [redacted]"],
  // A field whose value starts with a scheme word.
  ["token: Bearer abcdefgh123", "token: [redacted]"],
  ["X-Api-Key: Bearer abcdefgh123", "X-Api-Key: [redacted]"],
  ["api_key: Bearer abcdefgh123", "api_key: [redacted]"],
  ["secret = Basic dXNlcjpwYXNz", "secret = [redacted]"],
  // Output cut off inside a value, or a quote that never closes.
  ['Authorization: "abcsecret', 'Authorization: "[redacted]'],
  ["Authorization: 'quoted", "Authorization: '[redacted]"],
  ['{"token": "abcsecret', '{"token": "[redacted]'],
  ["x-api-key: abcsecr", "x-api-key: [redacted]"],
  // A JSON body keeps its other fields; only the quoted value goes.
  [
    '{"token": "abc123", "name": "bob", "n": 1}',
    '{"token": "[redacted]", "name": "bob", "n": 1}',
  ],
  [
    '{\\"token\\":\\"abc123\\",\\"name\\":\\"bob\\"}',
    '{\\"token\\":\\"[redacted]\\",\\"name\\":\\"bob\\"}',
  ],
  [
    '{"password": "a\\"b", "name": "bob"}',
    '{"password": "[redacted]", "name": "bob"}',
  ],
  // A header typed inside a quoted shell string keeps the rest of the command.
  [
    "curl -H 'Authorization: Bearer abc123XYZ' -H 'Accept: json' https://x",
    "curl -H 'Authorization: [redacted]' -H 'Accept: json' https://x",
  ],
  // A bare scheme word followed by a credential-shaped word, to the line end.
  ["Bearer abc123XYZdef and the rest", "Bearer [redacted]"],
  ["Basic dXNlcjpwYXNz\nnext line", "Basic [redacted]\nnext line"],
  // Ordinary text.
  ["Basic authentication is required", "Basic authentication is required"],
  ["Bearer of bad news", "Bearer of bad news"],
  ["the token is used for auth", "the token is used for auth"],
  [
    "token count is 5, see the password reset page",
    "token count is 5, see the password reset page",
  ],
  ["max_tokens=100 tokenizer: fast", "max_tokens=100 tokenizer: fast"],
])("blunt rule: %s", (input, expected) => {
  expect(redactText(input)).toBe(expected);
  expect(redactText(expected)).toBe(expected);
});

test("redacts a credential in a tool input and a tool output", () => {
  const command =
    'curl -H "x-api-key: sk-test-1234567890abcdef" https://example.com';
  expect(scrubInput(command)).toBe(
    'curl -H "x-api-key: [redacted]" https://example.com'
  );
  expect(
    redactToolPayload({
      ok: true,
      output: "Authorization: Bearer abc.def.ghi-jklmnop",
      toolUseId: TOOL_USE_ID,
    })
  ).toEqual({
    ok: true,
    output: "Authorization: [redacted]",
    toolUseId: TOOL_USE_ID,
  });
});

test.each([
  ["Anthropic key", "sk-ant-api03-AbCdEf1234567890xyz"],
  ["OpenRouter key", "sk-or-v1-abcdef1234567890abcd"],
  ["generic sk key", "sk-proj1234567890abcdef"],
  ["GitHub ghp", `ghp_${"A1b2".repeat(9)}`],
  ["GitHub gho", `gho_${"A1b2".repeat(9)}`],
  ["GitHub ghu", `ghu_${"A1b2".repeat(9)}`],
  ["GitHub ghs", `ghs_${"A1b2".repeat(9)}`],
  ["GitHub ghr", `ghr_${"A1b2".repeat(9)}`],
  ["GitHub fine-grained", "github_pat_11ABCDEFGHIJKLMNOPQRS"],
  ["Slack xoxb", "xoxb-1234567890-abcdefghij"],
  ["Slack xoxp", "xoxp-1234567890-abcdefghij"],
  ["Slack xoxa", "xoxa-1234567890-abcdefghij"],
  ["Slack xoxr", "xoxr-1234567890-abcdefghij"],
  ["Slack xoxs", "xoxs-1234567890-abcdefghij"],
  ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
  ["AWS session key", "ASIAIOSFODNN7EXAMPLE"],
  [
    "JWT",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ],
])("redacts a well-known %s token", (_label, token) => {
  expect(redactText(token)).toBe(REDACTED);
  expect(redactText(`see ${token} now`)).toBe(`see ${REDACTED} now`);
  expect(scrubInput(token)).toBe(REDACTED);
  expect(scrubOutput(token)).toBe(REDACTED);
});

test("redacts a Bearer token and keeps the word Bearer", () => {
  expect(redactText("Bearer abcdefgh12")).toBe("Bearer [redacted]");
  expect(redactText("auth Bearer abc.def-ghi_jkl~mno+pq/rs==")).toBe(
    "auth Bearer [redacted]"
  );
});

test.each([
  "token count",
  "password reset page",
  "the token is used for auth",
  "max_tokens=100",
  "task-management-roadmap",
  "Bearer of bad news",
  "tokens: 5",
  "tokenizer: fast",
])("leaves ordinary text unchanged: %s", (text) => {
  expect(redactText(text)).toBe(text);
});

test("keeps name, id and ok intact and leaves non-strings and keys alone", () => {
  const payload: Payload = {
    count: 3,
    flag: true,
    missing: null,
    ok: false,
    output: "password=hunter2",
    "token=abc123": "keep the key",
    toolUseId: TOOL_USE_ID,
  };
  expect(redactToolPayload(payload)).toEqual({
    count: 3,
    flag: true,
    missing: null,
    ok: false,
    output: "password=[redacted]",
    "token=abc123": "keep the key",
    toolUseId: TOOL_USE_ID,
  });
});

test("walks nested arrays and objects", () => {
  const payload: Payload = {
    input: {
      list: ["sk-ant-api03-AbCdEf1234567890xyz", { deep: "Cookie: a=1" }],
    },
  };
  expect(redactToolPayload(payload)).toEqual({
    input: {
      list: ["[redacted]", { deep: "Cookie: [redacted]" }],
    },
  });
});

test("does not mutate its input", () => {
  const payload: Payload = {
    input: { command: "token=abc123&x=1", list: ["password=hunter2"] },
    name: TOOL_NAME,
    toolUseId: TOOL_USE_ID,
  };
  const before = JSON.stringify(payload);
  const result = redactToolPayload(payload);
  expect(JSON.stringify(payload)).toBe(before);
  expect(result).not.toBe(payload);
});

test("is idempotent", () => {
  const samples = [
    'curl -H "x-api-key: sk-test-1234567890abcdef" https://example.com',
    '{"password": "hunter2hunter2"}',
    "Authorization: Bearer abc.def.ghi-jklmnop",
    '"Authorization": "Bearer abcdefgh"',
    "Cookie: a=1; b=2",
    "token=abc123&x=1",
    "sk-ant-api03-AbCdEf1234567890xyz",
    "Bearer abcdefgh12",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const sample of samples) {
    const once = redactText(sample);
    expect(redactText(once)).toBe(once);
  }
});

test("scrubs a megabyte of realistic mixed text in time", () => {
  const parts: string[] = [];
  let length = 0;
  let index = 0;
  while (length < MEGABYTE) {
    index += 1;
    const part =
      index % SENTENCE_EVERY === 0
        ? "password: hunter2hunter2\nAuthorization: Bearer abc.def.ghi-jklmnop\nsk-ant-api03-AbCdEf1234567890xyz\n"
        : SENTENCE;
    parts.push(part);
    length += part.length;
  }
  const text = parts.join("");
  let output = "";
  const elapsed = timed(() => {
    output = redactText(text);
  });
  expect(output).not.toContain("hunter2");
  expect(output).not.toContain("sk-ant-api03");
  expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
});

test.each([
  ["a-", "a-".repeat(REPEAT_HOSTILE)],
  ["eyJ", "eyJ".repeat(REPEAT_JWT)],
  ["sk-", "sk-".repeat(REPEAT_SK)],
  ["password=", "password=".repeat(REPEAT_PASSWORD)],
  ["Bearer ", "Bearer ".repeat(REPEAT_BEARER)],
  ["escaped password=", 'password=\\"'.repeat(REPEAT_ESCAPED)],
  ["Authorization: a", "Authorization: a ".repeat(REPEAT_AUTH)],
  ['token="', 'token="'.repeat(REPEAT_QUOTE)],
  ["quoted header", '"x-api-key: '.repeat(REPEAT_QUOTED_HEADER)],
  ["-key=", "-key=".repeat(REPEAT_KEY)],
])("scrubs a hostile megabyte of %s in time", (_label, hostile) => {
  const elapsed = timed(() => redactText(hostile));
  expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
});
