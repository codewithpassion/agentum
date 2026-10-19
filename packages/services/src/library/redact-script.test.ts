import { expect, test } from "bun:test";
import { redactScript } from "./redact-script.ts";

const SECRET = "SECRET";

const leaks = (script: string): boolean =>
  redactScript(script).includes(SECRET);

test("a script without curl is logged as typed", () => {
  const script = `cut -d, -f1 data.csv\nsort -u names.txt\ngrep -H "token:abc" x *\necho https://x.io/?q=1`;
  expect(redactScript(script)).toBe(script);
});

test("a curl line keeps only the host", () => {
  expect(
    redactScript(
      `curl -s -H "Authorization: Bearer ${SECRET}" https://API.example.com:8443/v1/items?token=${SECRET}`
    )
  ).toBe("curl api.example.com [arguments redacted]");
});

test("other lines stay as typed", () => {
  expect(
    redactScript(
      `ls /library\ncurl -u alice:${SECRET} https://x.io/\ncat out.txt`
    )
  ).toBe("ls /library\ncurl x.io [arguments redacted]\ncat out.txt");
});

test("every spelling of an option value is dropped", () => {
  for (const script of [
    `curl -H"Authorization: Bearer ${SECRET}" https://x.io/`,
    `curl -H'X-Token: ${SECRET}' https://x.io/`,
    `curl -sH "X-Token: ${SECRET}" https://x.io/`,
    `curl -sH"X-Token: ${SECRET}" https://x.io/`,
    `curl -HX-Api-Key:${SECRET} https://x.io/`,
    `curl -su alice:${SECRET} https://x.io/`,
    `curl -ualice:${SECRET} https://x.io/`,
    `curl -dtoken=${SECRET} https://x.io/`,
    `curl -d "{\\"token\\":\\"${SECRET}\\"}" https://x.io/`,
    `curl --data-raw '{"t":"${SECRET}"}' https://x.io/`,
    `curl --header=Authorization:${SECRET} https://x.io/`,
    `curl -H $'Authorization: ${SECRET}' https://x.io/`,
    `curl -d \\\n  '{"a":"${SECRET}"}' \\\n  https://x.io/`,
  ]) {
    expect(leaks(script)).toBe(false);
    expect(redactScript(script)).toBe("curl x.io [arguments redacted]");
  }
});

test("curl behind a pipe, a list, a substitution or a wrapper is found", () => {
  expect(
    redactScript(`echo go && curl -H "A: ${SECRET}" https://x.io/ | jq .`)
  ).toBe("curl x.io [arguments redacted]");
  expect(
    redactScript(`out=$(curl -H "A: ${SECRET}" https://x.io/)\necho "$out"`)
  ).toBe('curl x.io [arguments redacted]\necho "$out"');
  expect(
    redactScript(`echo https://x.io/ | xargs -n1 curl -H "A: ${SECRET}"`)
  ).toBe("curl x.io [arguments redacted]");
  expect(redactScript(`/usr/bin/curl -u a:${SECRET} https://x.io/`)).toBe(
    "curl x.io [arguments redacted]"
  );
});

test("a host that cannot be read safely is left out", () => {
  for (const script of [
    `curl -u a:${SECRET} example.com`,
    `curl -H "A: ${SECRET}" https://user:${SECRET}@x.io/`,
    `curl -H "A: ${SECRET}" https://$HOST/`,
    `curl -H "A: ${SECRET}" "https://$(echo x.io)/"`,
    `curl -H "A: ${SECRET}" -K cfg`,
  ]) {
    expect(leaks(script)).toBe(false);
    expect(redactScript(script)).toBe("curl [arguments redacted]");
  }
});

test("a script that cannot be read with confidence is replaced whole", () => {
  for (const script of [
    `c=curl; $c -H "A: ${SECRET}" https://x.io/`,
    `c=curl\n$c -H "A: ${SECRET}" https://x.io/`,
    `alias get=curl\nget -H "A: ${SECRET}" https://x.io/`,
    `bash -c "curl -H 'A: ${SECRET}' https://x.io/"`,
    `echo "curl docs"; echo ${SECRET}`,
    `curl -d @- https://x.io/ <<EOF\ntoken=${SECRET}\nEOF`,
    `curl -d '{\n"a":"${SECRET}"\n}' https://x.io/`,
    `echo $(curl -H "A: ${SECRET}" https://x.io/`,
    `"cu""rl" ${SECRET}\nCURL=curl`,
  ]) {
    expect(leaks(script)).toBe(false);
    expect(redactScript(script)).toBe("[script redacted: contains curl]");
  }
});

test("several curl lines in a row are each reduced", () => {
  expect(
    redactScript(
      `curl -u a:${SECRET} https://a.io/\ncurl -u b:${SECRET} https://b.io/\ncurl -u c:${SECRET} https://c.io/`
    )
  ).toBe(
    "curl a.io [arguments redacted]\ncurl b.io [arguments redacted]\ncurl c.io [arguments redacted]"
  );
});

test("a long script is handled in linear time", () => {
  const script = `curl ${"-H x ".repeat(2000)} https://x.io/`;
  const started = Date.now();
  redactScript(script);
  redactScript(`${'curl "'.repeat(1500)}`);
  expect(Date.now() - started).toBeLessThan(500);
});
