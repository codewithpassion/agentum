import { beforeEach, describe, expect, test } from "bun:test";
import {
  createFlyGateway,
  FlyApiError,
  type FlyMachineConfig,
} from "./fly-gateway";

/**
 * What this server actually sends Fly. There is no Fly account behind any of
 * this, so the request shapes are the only thing that can be checked at all -
 * and they are the thing most likely to be wrong, because they were written
 * from Fly's documentation rather than from a reply.
 *
 * The `fetch` is injected: nothing here touches a network.
 */

const TOKEN = "fly_deploy_token";
const APP = "agentum-computers";

interface Call {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

let calls: Call[] = [];
let reply: { body: unknown; status: number } = {
  body: { id: "m-1", state: "created" },
  status: 200,
};

const fakeFetch = ((url: string, init: RequestInit) => {
  calls.push({
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    headers: init.headers as Record<string, string>,
    method: String(init.method),
    url: String(url),
  });
  return Promise.resolve(Response.json(reply.body, { status: reply.status }));
}) as unknown as typeof fetch;

const gateway = () => createFlyGateway(TOKEN, fakeFetch);

const lastCall = (): Call => calls.at(-1) as Call;

const MACHINE_CONFIG: FlyMachineConfig = {
  env: { COMPUTERD_MODE: "listen" },
  image: "ghcr.io/codewithpassion/agentum-computerd:latest",
};

beforeEach(() => {
  calls = [];
  reply = { body: { id: "m-1", state: "created" }, status: 200 };
});

describe("the requests the gateway makes", () => {
  test("every call carries the API token as a bearer credential", async () => {
    reply = { body: { name: APP, status: "deployed" }, status: 200 };

    await gateway().getApp(APP);

    expect(lastCall().headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("getApp reads one app", async () => {
    reply = { body: { name: APP, status: "deployed" }, status: 200 };

    const app = await gateway().getApp(APP);

    expect(app).toEqual({ name: APP, status: "deployed" });
    expect(lastCall().method).toBe("GET");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers"
    );
  });

  test("createVolume posts the name, the size and the region", async () => {
    reply = { body: { id: "vol-1", name: "agent_abc" }, status: 200 };

    const volume = await gateway().createVolume(APP, {
      name: "agent_abc",
      region: "ams",
      sizeGb: 10,
    });

    expect(volume).toEqual({ id: "vol-1", name: "agent_abc" });
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/volumes"
    );
    expect(lastCall().body).toEqual({
      name: "agent_abc",
      region: "ams",
      size_gb: 10,
    });
  });

  test("createVolume leaves the region out when the host has none", async () => {
    reply = { body: { id: "vol-1", name: "agent_abc" }, status: 200 };

    await gateway().createVolume(APP, { name: "agent_abc", sizeGb: 3 });

    expect(lastCall().body).toEqual({ name: "agent_abc", size_gb: 3 });
  });

  test("deleteVolume addresses the volume by id", async () => {
    reply = { body: { id: "vol-1" }, status: 200 };

    await gateway().deleteVolume(APP, "vol-1");

    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/volumes/vol-1"
    );
  });

  test("createMachine posts the config, the name and the region", async () => {
    const machine = await gateway().createMachine(APP, {
      config: MACHINE_CONFIG,
      name: "agent-abc",
      region: "ams",
    });

    expect(machine).toEqual({ config: null, id: "m-1", state: "created" });
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/machines"
    );
    expect(lastCall().body).toEqual({
      config: MACHINE_CONFIG,
      name: "agent-abc",
      region: "ams",
    });
  });

  test("getMachine returns the state and the config a rotation needs", async () => {
    reply = {
      body: { config: MACHINE_CONFIG, id: "m-1", state: "started" },
      status: 200,
    };

    const machine = await gateway().getMachine(APP, "m-1");

    expect(machine.state).toBe("started");
    expect(machine.config).toEqual(
      MACHINE_CONFIG as unknown as typeof machine.config
    );
    expect(lastCall().method).toBe("GET");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/machines/m-1"
    );
  });

  test("updateMachine posts the whole config back", async () => {
    await gateway().updateMachine(APP, "m-1", MACHINE_CONFIG);

    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/machines/m-1"
    );
    expect(lastCall().body).toEqual({ config: MACHINE_CONFIG });
  });

  test("stopMachine posts to the stop endpoint", async () => {
    reply = { body: { ok: true }, status: 200 };

    await gateway().stopMachine(APP, "m-1");

    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/machines/m-1/stop"
    );
  });

  test("deleteMachine forces when asked, so a running machine still goes", async () => {
    reply = { body: { ok: true }, status: 200 };

    await gateway().deleteMachine(APP, "m-1", { force: true });

    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/machines/m-1?force=true"
    );
  });

  test("deleteMachine without force sends no query", async () => {
    reply = { body: { ok: true }, status: 200 };

    await gateway().deleteMachine(APP, "m-1");

    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/agentum-computers/machines/m-1"
    );
  });

  test("an app name with a slash cannot escape its path", async () => {
    reply = { body: { name: "x" }, status: 200 };

    await gateway().getApp("../../apps/other");

    expect(lastCall().url).toBe(
      "https://api.machines.dev/v1/apps/..%2F..%2Fapps%2Fother"
    );
  });
});

describe("what Fly refuses", () => {
  test("a rejection keeps Fly's own message and status", async () => {
    reply = { body: { message: "volume name is taken" }, status: 422 };

    const failure = gateway().createVolume(APP, { name: "a", sizeGb: 1 });

    await expect(failure).rejects.toThrow(FlyApiError);
    await expect(failure).rejects.toThrow("volume name is taken");
  });

  test("an `error` body is read too, since Fly uses both", async () => {
    reply = { body: { error: "machine not found" }, status: 404 };

    await expect(gateway().getMachine(APP, "gone")).rejects.toThrow(
      "machine not found"
    );
  });

  test("a body with no message at all still reports the status", async () => {
    reply = { body: "nope", status: 500 };

    await expect(gateway().getApp(APP)).rejects.toThrow("HTTP 500");
  });

  test("the status is on the error, for a caller that wants to branch", async () => {
    reply = { body: { message: "unauthorized" }, status: 401 };

    try {
      await gateway().getApp(APP);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlyApiError);
      expect((error as FlyApiError).status).toBe(401);
    }
  });

  test("a success that is not the shape we asked for is refused", async () => {
    reply = { body: { id: "m-1" }, status: 200 };

    await expect(gateway().getMachine(APP, "m-1")).rejects.toThrow(
      "could not understand"
    );
  });
});
