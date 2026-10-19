import { describe, expect, test } from "bun:test";
import type { EnvGrant } from "@repo/services/secrets/placeholders";
import {
  type FilledHop,
  fillHop,
  type SecretHop,
  scrubSecrets,
} from "./hop-secrets.ts";

const VALUE = "sk-123/+&secret";
const PLACEHOLDER = "hm-secret:SUPADATA_KEY";
const SUPADATA: EnvGrant = {
  hosts: ["api.supadata.ai"],
  name: "SUPADATA_KEY",
  value: VALUE,
};
const OTHER: EnvGrant = {
  hosts: ["other.example.com"],
  name: "OTHER_KEY",
  value: "other-value",
};

const encode = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));
const decode = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes);

function hopOf(
  url: string,
  init: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {}
): SecretHop {
  return {
    body: init.body === undefined ? undefined : encode(init.body),
    headers: new Headers(init.headers),
    method: init.method ?? "POST",
    url: new URL(url),
  };
}

/** A loader that returns `grants` and counts its calls. */
function loaderOf(grants: readonly EnvGrant[]) {
  const calls = { count: 0 };
  const load = (): Promise<readonly EnvGrant[]> => {
    calls.count += 1;
    return Promise.resolve(grants);
  };
  return { calls, load };
}

function filledOf(result: FilledHop): SecretHop {
  if (!result.ok) {
    throw new Error(`expected a filled hop, got: ${result.message}`);
  }
  return result.hop;
}

function failureOf(result: FilledHop): { message: string } {
  if (result.ok) {
    throw new Error("expected a refusal, got a filled hop");
  }
  return result;
}

describe("fillHop", () => {
  test("fills a header placeholder with the raw value for an exact host", async () => {
    const hop = hopOf("https://api.supadata.ai/v1/scrape", {
      headers: { "x-api-key": "hm-secret:SUPADATA_KEY" },
      method: "PATCH",
    });
    const result = await fillHop(hop, loaderOf([SUPADATA]).load);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.names).toEqual(["SUPADATA_KEY"]);
    expect(result.hop.headers.get("x-api-key")).toBe(VALUE);
    expect(result.hop.method).toBe("PATCH");
    expect(result.hop.url.href).toBe("https://api.supadata.ai/v1/scrape");
  });

  test("fills a placeholder in the URL path and query, percent-encoded", async () => {
    const hop = hopOf(
      "https://api.supadata.ai/v1/hm-secret:SUPADATA_KEY?key=hm-secret:SUPADATA_KEY",
      { method: "GET" }
    );
    const filled = filledOf(await fillHop(hop, loaderOf([SUPADATA]).load));

    expect(filled.url.pathname).toBe(`/v1/${encodeURIComponent(VALUE)}`);
    expect(filled.url.searchParams.get("key")).toBe(VALUE);
    expect(filled.url.search).toBe(`?key=${encodeURIComponent(VALUE)}`);
  });

  test("fills a placeholder in a text body", async () => {
    const hop = hopOf("https://api.supadata.ai/v1/x", {
      body: '{"key":"hm-secret:SUPADATA_KEY"}',
    });
    const filled = filledOf(await fillHop(hop, loaderOf([SUPADATA]).load));

    expect(decode(filled.body)).toBe(`{"key":"${VALUE}"}`);
  });

  test("fills for a wildcard host pattern", async () => {
    const grant: EnvGrant = {
      hosts: ["*.supadata.ai"],
      name: "SUPADATA_KEY",
      value: VALUE,
    };
    const hop = hopOf("https://api.supadata.ai/v1/x", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const filled = filledOf(await fillHop(hop, loaderOf([grant]).load));

    expect(filled.headers.get("authorization")).toBe(`Bearer ${VALUE}`);
  });

  test("leaves the input hop unchanged", async () => {
    const hop = hopOf("https://api.supadata.ai/v1/hm-secret:SUPADATA_KEY", {
      body: "hm-secret:SUPADATA_KEY",
      headers: { "x-api-key": "hm-secret:SUPADATA_KEY" },
    });
    const before = {
      body: decode(hop.body),
      header: hop.headers.get("x-api-key"),
      href: hop.url.href,
    };
    const result = await fillHop(hop, loaderOf([SUPADATA]).load);

    expect(result.ok).toBe(true);
    expect(hop.headers.get("x-api-key")).toBe(before.header);
    expect(hop.url.href).toBe(before.href);
    expect(decode(hop.body)).toBe(before.body);
    expect(hop.headers.get("x-api-key")).toBe("hm-secret:SUPADATA_KEY");
  });

  test("returns the same hop and never loads grants when no placeholder is present", async () => {
    const hop = hopOf("https://evil.example.com/x", {
      body: "plain text",
      headers: { accept: "text/plain" },
    });
    const { calls, load } = loaderOf([SUPADATA]);
    const result = await fillHop(hop, load);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hop).toBe(hop);
      expect(result.names).toEqual([]);
      expect(result.values.size).toBe(0);
    }
    expect(calls.count).toBe(0);
  });

  test("refuses a secret for a host it may not reach", async () => {
    const hop = hopOf("https://evil.example.com/", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const result = await fillHop(hop, loaderOf([SUPADATA]).load);

    expect(failureOf(result).message).toBe(
      "SUPADATA_KEY may only be sent to api.supadata.ai"
    );
    expect(result.ok).toBe(false);
  });

  test("refuses a secret with no allowed hosts", async () => {
    const grant: EnvGrant = { hosts: [], name: "SUPADATA_KEY", value: VALUE };
    const hop = hopOf("https://api.supadata.ai/", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const result = await fillHop(hop, loaderOf([grant]).load);

    expect(failureOf(result).message).toBe(
      "SUPADATA_KEY has no allowed hosts. Add them in Settings, Secrets."
    );
  });

  test("refuses a name the agent was not granted", async () => {
    const hop = hopOf("https://api.supadata.ai/", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const result = await fillHop(hop, loaderOf([]).load);

    expect(failureOf(result).message).toBe(
      "A placeholder in the request is not for a secret granted to this agent"
    );
  });

  test("refuses plain http", async () => {
    const hop = hopOf("http://api.supadata.ai/", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const result = await fillHop(hop, loaderOf([SUPADATA]).load);

    expect(failureOf(result).message).toBe("A secret is only sent over https");
  });

  test("refuses the whole hop when one of two placeholders is refused", async () => {
    const hop = hopOf("https://api.supadata.ai/", {
      headers: {
        authorization: "Bearer hm-secret:SUPADATA_KEY",
        "x-other": "hm-secret:OTHER_KEY",
      },
    });
    const result = await fillHop(hop, loaderOf([SUPADATA, OTHER]).load);

    expect(failureOf(result).message).toBe(
      "OTHER_KEY may only be sent to other.example.com"
    );
  });

  test("leaves a binary body as it is and still fills a header", async () => {
    const bytes = new Uint8Array([
      0xff,
      0xfe,
      ...new TextEncoder().encode("hm-secret:SUPADATA_KEY"),
    ]);
    const hop: SecretHop = {
      body: bytes,
      headers: new Headers({ authorization: "Bearer hm-secret:SUPADATA_KEY" }),
      method: "POST",
      url: new URL("https://api.supadata.ai/upload"),
    };
    const filled = filledOf(await fillHop(hop, loaderOf([SUPADATA]).load));

    expect(filled.headers.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(filled.body).toEqual(bytes);
  });

  test("does not expand a placeholder that appears inside a value", async () => {
    const grant: EnvGrant = {
      hosts: ["api.supadata.ai"],
      name: "SUPADATA_KEY",
      value: "hm-secret:OTHER_KEY",
    };
    const hop = hopOf("https://api.supadata.ai/", {
      headers: { "x-key": "hm-secret:SUPADATA_KEY" },
    });
    const filled = filledOf(await fillHop(hop, loaderOf([grant, OTHER]).load));

    expect(filled.headers.get("x-key")).toBe("hm-secret:OTHER_KEY");
  });

  test("keeps $& in a value literal", async () => {
    const grant: EnvGrant = {
      hosts: ["api.supadata.ai"],
      name: "SUPADATA_KEY",
      value: "a$&b$1",
    };
    const hop = hopOf("https://api.supadata.ai/", {
      body: "k=hm-secret:SUPADATA_KEY",
    });
    const filled = filledOf(await fillHop(hop, loaderOf([grant]).load));

    expect(decode(filled.body)).toBe("k=a$&b$1");
  });

  test("gives a blocked message and never the error text when loadGrants rejects", async () => {
    const hop = hopOf("https://api.supadata.ai/", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const result = await fillHop(hop, () =>
      Promise.reject(new Error(`lookup failed for ${VALUE}`))
    );

    expect(failureOf(result).message).toBe(
      "The platform could not read this agent's secrets"
    );
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  test("gives bad_request, without the value, for a value a header cannot hold", async () => {
    const grant: EnvGrant = {
      hosts: ["api.supadata.ai"],
      name: "SUPADATA_KEY",
      value: "line-one\nline-two",
    };
    const hop = hopOf("https://api.supadata.ai/", {
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const result = await fillHop(hop, loaderOf([grant]).load);

    expect(result).toEqual({
      error: "bad_request",
      message: "A header value is not valid",
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("line-one");
  });

  test("refuses a placeholder that would move the credentials into the userinfo", async () => {
    const grant: EnvGrant = {
      hosts: ["api.supadata.ai"],
      name: "SUPADATA_KEY",
      value: "@evil.com/",
    };
    const hop = hopOf("https://hm-secret:SUPADATA_KEY@api.supadata.ai/", {
      method: "GET",
    });
    const result = await fillHop(hop, loaderOf([grant]).load);

    expect(failureOf(result).message).toBe(
      "A secret cannot go in that part of the URL"
    );
    expect(JSON.stringify(result)).not.toContain("evil.com");
  });

  test("never puts a value in a failed result", async () => {
    const hop = hopOf("http://evil.example.com/hm-secret:SUPADATA_KEY", {
      body: "hm-secret:SUPADATA_KEY",
      headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
    });
    const cases: FilledHop[] = [
      await fillHop(hop, loaderOf([SUPADATA]).load),
      await fillHop(
        hopOf("https://evil.example.com/", {
          headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
        }),
        loaderOf([SUPADATA]).load
      ),
      await fillHop(
        hopOf("https://api.supadata.ai/", {
          headers: { authorization: "Bearer hm-secret:SUPADATA_KEY" },
        }),
        loaderOf([{ hosts: [], name: "SUPADATA_KEY", value: VALUE }]).load
      ),
    ];
    for (const result of cases) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(VALUE);
    }
  });

  describe("scrubSecrets", () => {
    const AWS = "Abcd/ef+gh=ij1234";
    const values = new Map([["SUPADATA_KEY", AWS]]);

    test("puts the placeholder back for the raw and the encoded value", () => {
      const text = `https://a.example/y?k=${encodeURIComponent(AWS)}&raw=${AWS}`;
      expect(scrubSecrets(text, values)).toBe(
        `https://a.example/y?k=${PLACEHOLDER}&raw=${PLACEHOLDER}`
      );
    });

    test("matches hex digits and letters of either case", () => {
      const text = `${encodeURIComponent(AWS).toLowerCase()} ${AWS.toUpperCase()}`;
      expect(scrubSecrets(text, values)).toBe(`${PLACEHOLDER} ${PLACEHOLDER}`);
    });

    test("replaces the longer of two values first", () => {
      const both = new Map([
        ["SHORT_KEY", "abcdefgh"],
        ["LONG_KEY", "abcdefgh-and-more"],
      ]);
      expect(scrubSecrets("x abcdefgh-and-more y", both)).toBe(
        "x hm-secret:LONG_KEY y"
      );
    });

    test("leaves a text without a value, and any text without values, alone", () => {
      expect(scrubSecrets("https://a.example/", values)).toBe(
        "https://a.example/"
      );
      expect(scrubSecrets("abc", new Map())).toBe("abc");
    });

    test("a value with regex characters is replaced as text", () => {
      const odd = new Map([["ODD_KEY", "a.b*c(d)[e]|f$g^h"]]);
      expect(scrubSecrets("k=a.b*c(d)[e]|f$g^h", odd)).toBe(
        "k=hm-secret:ODD_KEY"
      );
      expect(scrubSecrets("k=aXb*c(d)[e]|f$g^h", odd)).toBe(
        "k=aXb*c(d)[e]|f$g^h"
      );
    });
  });

  test("a placeholder only in the fragment is neither filled nor counted", async () => {
    const hop = hopOf(`https://api.supadata.ai/x#${PLACEHOLDER}`);
    const { calls, load } = loaderOf([SUPADATA]);
    const result = await fillHop(hop, load);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.names).toEqual([]);
      expect(result.hop.url.hash).toBe(`#${PLACEHOLDER}`);
    }
    expect(calls.count).toBe(0);
  });

  test("a fragment is dropped from the url that is sent", async () => {
    const hop = hopOf(`https://api.supadata.ai/x?k=${PLACEHOLDER}#frag`);
    const filled = filledOf(await fillHop(hop, loaderOf([SUPADATA]).load));
    expect(filled.url.hash).toBe("");
    expect(filled.url.href).not.toContain("frag");
  });
});
