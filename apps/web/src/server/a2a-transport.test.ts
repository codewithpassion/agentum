import { describe, expect, test } from "bun:test";
import {
  createCardFetcher,
  createPairingTransport,
  createPeerFetch,
} from "./a2a-transport.ts";

interface Call {
  init?: RequestInit;
  url: string;
}

/** A fake network `fetch` that records each call and answers with `respond`. */
const fakeNetwork = (
  respond: (
    url: string,
    init?: RequestInit
  ) => Promise<Response> | Response = () => new Response("{}", { status: 200 })
) => {
  const calls: Call[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ init, url });
    return Promise.resolve(respond(url, init));
  };
  return { calls, fetch: fetchFn as typeof fetch };
};

/** A fake in-process handler that records each request. */
const fakeLocal = (status = 200) => {
  const requests: Request[] = [];
  const handler = (request: Request) => {
    requests.push(request);
    return Promise.resolve(Response.json({}, { status }));
  };
  return { handler, requests };
};

const PUBLIC_URL = "https://peer.example.com/a2a";
const BASE = "https://harbour.example.com";

describe("createPeerFetch", () => {
  test("refuses private addresses without calling the network", async () => {
    const network = fakeNetwork();
    const peerFetch = createPeerFetch({
      allowHttp: false,
      fetch: network.fetch,
    });

    await expect(peerFetch("https://10.0.0.1/a2a", {})).rejects.toThrow(
      "Request to a peer refused"
    );
    await expect(peerFetch("https://localhost/", {})).rejects.toThrow(
      "Request to a peer refused"
    );
    expect(network.calls).toHaveLength(0);
  });

  test("refuses a redirect from the network instead of following it", async () => {
    const network = fakeNetwork(() =>
      Response.redirect("https://other.example.com/", 302)
    );
    const peerFetch = createPeerFetch({
      allowHttp: false,
      fetch: network.fetch,
    });

    await expect(peerFetch(PUBLIC_URL, {})).rejects.toThrow("redirect");
    expect(network.calls[0]?.init?.redirect).toBe("manual");
  });

  test("refuses plain http outside dev and allows it when allowHttp is set", async () => {
    const refusedNetwork = fakeNetwork();
    const refusedFetch = createPeerFetch({
      allowHttp: false,
      fetch: refusedNetwork.fetch,
    });
    await expect(
      refusedFetch("http://peer.example.com/a2a", {})
    ).rejects.toThrow("only https URLs are allowed");
    expect(refusedNetwork.calls).toHaveLength(0);

    const allowedNetwork = fakeNetwork();
    const allowedFetch = createPeerFetch({
      allowHttp: true,
      fetch: allowedNetwork.fetch,
    });
    const response = await allowedFetch("http://peer.example.com/a2a", {});
    expect(response.status).toBe(200);
    expect(allowedNetwork.calls.map((call) => call.url)).toEqual([
      "http://peer.example.com/a2a",
    ]);
  });

  test("sends a request for the public base origin to localFetch, even for localhost", async () => {
    const network = fakeNetwork();
    const local = fakeLocal();
    const peerFetch = createPeerFetch({
      allowHttp: true,
      fetch: network.fetch,
      localFetch: local.handler,
      publicBaseUrl: "http://localhost:3000",
    });

    await peerFetch("http://localhost:3000/a2a/card?x=1", {
      body: "{}",
      method: "POST",
    });

    expect(network.calls).toHaveLength(0);
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]?.url).toBe("http://localhost:3000/a2a/card?x=1");
    expect(local.requests[0]?.method).toBe("POST");
  });

  test("sends a request for another origin to the network, never to localFetch", async () => {
    const network = fakeNetwork();
    const local = fakeLocal();
    const peerFetch = createPeerFetch({
      allowHttp: false,
      fetch: network.fetch,
      localFetch: local.handler,
      publicBaseUrl: BASE,
    });

    await peerFetch(PUBLIC_URL, {});

    expect(local.requests).toHaveLength(0);
    expect(network.calls.map((call) => call.url)).toEqual([PUBLIC_URL]);
  });

  test("rejects with a TimeoutError when the network never answers", async () => {
    const network = fakeNetwork(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          );
        })
    );
    const peerFetch = createPeerFetch({
      allowHttp: false,
      fetch: network.fetch,
      timeoutMs: 20,
    });

    const error: unknown = await peerFetch(PUBLIC_URL, {}).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  test("refuses a redirect from localFetch", async () => {
    const local = fakeLocal(301);
    const peerFetch = createPeerFetch({
      allowHttp: false,
      fetch: fakeNetwork().fetch,
      localFetch: local.handler,
      publicBaseUrl: BASE,
    });

    await expect(peerFetch(`${BASE}/a2a/card`, {})).rejects.toThrow("redirect");
  });
});

describe("createPairingTransport", () => {
  const SECRET_BEARER = "bearer-secret-value-0123456789abcdef";
  const SECRET_TOKEN = "token-secret-value-0123456789abcdef";

  test("activate posts the token with the bearer and resolves on a 2xx answer", async () => {
    const network = fakeNetwork();
    const transport = createPairingTransport(network.fetch);

    await transport.activate({
      bearer: SECRET_BEARER,
      token: SECRET_TOKEN,
      url: "https://peer.example.com/a2a/pair/activate",
    });

    const [call] = network.calls;
    expect(call?.url).toBe("https://peer.example.com/a2a/pair/activate");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toEqual({
      Authorization: `Bearer ${SECRET_BEARER}`,
      "Content-Type": "application/json",
    });
    expect(call?.init?.body).toBe(JSON.stringify({ token: SECRET_TOKEN }));
  });

  test("activate throws on a non-2xx answer without the secrets in the message", async () => {
    const network = fakeNetwork(
      () =>
        new Response(`refused ${SECRET_TOKEN} ${SECRET_BEARER}`, {
          status: 403,
        })
    );
    const transport = createPairingTransport(network.fetch);

    const error: unknown = await transport
      .activate({ bearer: SECRET_BEARER, token: SECRET_TOKEN, url: PUBLIC_URL })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toContain("403");
    expect(message).not.toContain(SECRET_TOKEN);
    expect(message).not.toContain(SECRET_BEARER);
  });

  test("join posts the body with the invite as bearer and resolves to the parsed answer", async () => {
    const answer = {
      agentName: "Inviter",
      cardUrl: `${BASE}/a2a/card`,
      orgName: "Org",
    };
    const network = fakeNetwork(() => Response.json(answer));
    const transport = createPairingTransport(network.fetch);
    const body = {
      agentName: "Joiner",
      cardUrl: "https://joiner.example.com/a2a/card",
      token: SECRET_TOKEN,
    };

    const result = await transport.join({
      body,
      inviteToken: SECRET_BEARER,
      origin: "https://peer.example.com",
    });

    const [call] = network.calls;
    expect(result).toEqual(answer);
    expect(call?.url).toBe("https://peer.example.com/a2a/pair/join");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toEqual({
      Authorization: `Bearer ${SECRET_BEARER}`,
      "Content-Type": "application/json",
    });
    expect(call?.init?.body).toBe(JSON.stringify(body));
  });

  test("join throws on a non-2xx answer without the invite or the body in the message", async () => {
    const network = fakeNetwork(
      () => new Response(`no ${SECRET_BEARER}`, { status: 401 })
    );
    const transport = createPairingTransport(network.fetch);

    const error: unknown = await transport
      .join({
        body: { agentName: "Joiner", cardUrl: PUBLIC_URL, token: SECRET_TOKEN },
        inviteToken: SECRET_BEARER,
        origin: "https://peer.example.com",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toContain("401");
    expect(message).not.toContain(SECRET_BEARER);
  });

  test("join throws when the answer is not JSON and does not echo it", async () => {
    const network = fakeNetwork(
      () => new Response(`<html>${SECRET_BEARER}</html>`, { status: 200 })
    );
    const transport = createPairingTransport(network.fetch);

    const error: unknown = await transport
      .join({
        body: { agentName: "Joiner", cardUrl: PUBLIC_URL, token: SECRET_TOKEN },
        inviteToken: SECRET_BEARER,
        origin: "https://peer.example.com",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).not.toContain(SECRET_BEARER);
  });
});

describe("createCardFetcher", () => {
  const fetchCard = (network: ReturnType<typeof fakeNetwork>) =>
    createCardFetcher(network.fetch);

  test("resolves to the parsed card JSON and sends the Accept header", async () => {
    const card = { name: "Peer", skills: [] };
    const network = fakeNetwork(() => Response.json(card));

    const result = await fetchCard(network)(PUBLIC_URL);

    expect(result).toEqual(card);
    expect(network.calls[0]?.init?.method).toBe("GET");
    expect(network.calls[0]?.init?.headers).toEqual({
      Accept: "application/json",
    });
  });

  test("refuses a non-2xx answer", async () => {
    const network = fakeNetwork(() => new Response("{}", { status: 404 }));

    await expect(fetchCard(network)(PUBLIC_URL)).rejects.toThrow("404");
  });

  test("refuses a body that is not JSON", async () => {
    const network = fakeNetwork(
      () => new Response("not json", { status: 200 })
    );

    await expect(fetchCard(network)(PUBLIC_URL)).rejects.toThrow("not JSON");
  });

  test("refuses a body over 262144 bytes", async () => {
    const oversize = `"${"x".repeat(262_144)}"`;
    const network = fakeNetwork(() => new Response(oversize, { status: 200 }));

    await expect(fetchCard(network)(PUBLIC_URL)).rejects.toThrow(
      "larger than 262144"
    );
  });
});

test("a handler for our own origin that never answers is cut off by the timeout", async () => {
  const peerFetch = createPeerFetch({
    allowHttp: false,
    fetch: () => Promise.reject(new Error("the network must not be used")),
    localFetch: () => new Promise<Response>(() => undefined),
    publicBaseUrl: "https://hm.test",
    timeoutMs: 20,
  });

  const error = await peerFetch("https://hm.test/a2a/x", {}).catch(
    (caught: unknown) => caught
  );

  expect((error as Error).name).toBe("TimeoutError");
});
