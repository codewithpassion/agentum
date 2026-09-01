/**
 * The whole Fly Machines API surface we depend on, behind one interface - the
 * `AnthropicGateway` pattern, for the same reason: it is a third party's HTTP
 * API, so every caller here can be exercised against a fake and nothing else in
 * the app learns Fly's URL shapes.
 *
 * Only what callers use is parsed. A machine's reply carries thirty fields; the
 * three that matter are its id, its state and the config a rotation has to send
 * back, so those are the three this file promises.
 *
 * **Unverified against a real account.** Every payload below follows
 * https://fly.io/docs/machines/api/ (machines and volumes resources) and has
 * never been sent to Fly - there is no Fly account behind this yet.
 */

const FLY_API_BASE = "https://api.machines.dev/v1";

/** Fly refused. `status` is the HTTP status; `message` is Fly's own wording. */
export class FlyApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FlyApiError";
    this.status = status;
  }
}

export interface FlyApp {
  name: string;
  status: string | null;
}

export interface FlyVolume {
  id: string;
  name: string;
}

/**
 * A machine as we read it back. `config` is passed through unparsed because the
 * only thing that reads it is the token rotation, which sends it straight back
 * with one env var changed - translating it twice could only lose fields.
 */
export interface FlyMachine {
  config: Record<string, unknown> | null;
  id: string;
  state: string;
}

/** One published port on a service, in Fly's spelling. */
export interface FlyServicePort {
  handlers: string[];
  port: number;
}

export interface FlyService {
  autostart: boolean;
  autostop: string;
  internal_port: number;
  ports: FlyServicePort[];
  protocol: string;
}

/**
 * The machine config, in Fly's spelling throughout: it is sent verbatim, and
 * the host's stored config already uses `memory_mb`, so nothing is renamed on
 * the way through.
 */
export interface FlyMachineConfig {
  env?: Record<string, string>;
  guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  image: string;
  mounts?: { path: string; volume: string }[];
  services?: FlyService[];
}

export interface CreateMachineInput {
  config: FlyMachineConfig;
  name?: string;
  /** Omitted means the app's primary region, which is Fly's documented default. */
  region?: string;
}

export interface CreateVolumeInput {
  name: string;
  region?: string;
  sizeGb: number;
}

export interface FlyGateway {
  createMachine: (
    app: string,
    input: CreateMachineInput
  ) => Promise<FlyMachine>;
  createVolume: (app: string, input: CreateVolumeInput) => Promise<FlyVolume>;
  deleteMachine: (
    app: string,
    id: string,
    options?: { force?: boolean }
  ) => Promise<void>;
  deleteVolume: (app: string, volumeId: string) => Promise<void>;
  getApp: (app: string) => Promise<FlyApp>;
  getMachine: (app: string, id: string) => Promise<FlyMachine>;
  stopMachine: (app: string, id: string) => Promise<void>;
  updateMachine: (
    app: string,
    id: string,
    config: FlyMachineConfig
  ) => Promise<FlyMachine>;
}

/** How a caller gets a gateway from a host's API token; the seam tests replace. */
export type FlyGatewayFactory = (apiToken: string) => FlyGateway;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Fly's documented error body is `{ status, message, code }`, but several
 * endpoints answer `{ error }` instead, so both are read before falling back to
 * the bare status.
 */
const messageOf = (payload: unknown, status: number): string => {
  if (isRecord(payload)) {
    if (typeof payload.message === "string" && payload.message) {
      return payload.message;
    }
    if (typeof payload.error === "string" && payload.error) {
      return payload.error;
    }
  }
  return `Fly answered HTTP ${status}.`;
};

const MALFORMED = "Fly sent a reply this server could not understand.";

const asMachine = (value: unknown): FlyMachine => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.state !== "string"
  ) {
    throw new Error(MALFORMED);
  }
  return {
    config: isRecord(value.config) ? value.config : null,
    id: value.id,
    state: value.state,
  };
};

const asVolume = (value: unknown): FlyVolume => {
  if (!(isRecord(value) && typeof value.id === "string")) {
    throw new Error(MALFORMED);
  }
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "",
  };
};

const asApp = (value: unknown): FlyApp => {
  if (!(isRecord(value) && typeof value.name === "string")) {
    throw new Error(MALFORMED);
  }
  return {
    name: value.name,
    status: typeof value.status === "string" ? value.status : null,
  };
};

const segment = (value: string): string => encodeURIComponent(value);

/**
 * `apiToken` is a Fly deploy token scoped to one app. It is never logged and
 * never put in an error message: Fly's own error bodies can quote the request
 * they were made with, which is why only `message` is read out of them.
 */
export const createFlyGateway = (
  apiToken: string,
  fetchImpl: typeof fetch = fetch
): FlyGateway => {
  const request = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> => {
    const response = await fetchImpl(`${FLY_API_BASE}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
    });
    const payload = parseJson(await response.text());
    if (!response.ok) {
      throw new FlyApiError(
        response.status,
        messageOf(payload, response.status)
      );
    }
    return payload;
  };

  return {
    async createMachine(app, input) {
      return asMachine(
        await request("POST", `/apps/${segment(app)}/machines`, {
          config: input.config,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.region === undefined ? {} : { region: input.region }),
        })
      );
    },

    async createVolume(app, input) {
      return asVolume(
        await request("POST", `/apps/${segment(app)}/volumes`, {
          name: input.name,
          size_gb: input.sizeGb,
          ...(input.region === undefined ? {} : { region: input.region }),
        })
      );
    },

    async deleteMachine(app, id, options) {
      const query = options?.force ? "?force=true" : "";
      await request(
        "DELETE",
        `/apps/${segment(app)}/machines/${segment(id)}${query}`
      );
    },

    async deleteVolume(app, volumeId) {
      await request(
        "DELETE",
        `/apps/${segment(app)}/volumes/${segment(volumeId)}`
      );
    },

    async getApp(app) {
      return asApp(await request("GET", `/apps/${segment(app)}`));
    },

    async getMachine(app, id) {
      return asMachine(
        await request("GET", `/apps/${segment(app)}/machines/${segment(id)}`)
      );
    },

    async stopMachine(app, id) {
      await request(
        "POST",
        `/apps/${segment(app)}/machines/${segment(id)}/stop`,
        {}
      );
    },

    async updateMachine(app, id, config) {
      return asMachine(
        await request("POST", `/apps/${segment(app)}/machines/${segment(id)}`, {
          config,
        })
      );
    },
  };
};
