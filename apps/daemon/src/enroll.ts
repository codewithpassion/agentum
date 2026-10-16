// `harbourmaster enroll <code> --server <url>`: trade the enrolment code for a
// machine credential, then write the config. The code arrives in argv, so it is
// visible to `ps`; it is single use and the server rejects a second try.

import {
  enrollRequestSchema,
  enrollResponseSchema,
} from "@repo/protocol/machine";
import { z } from "zod";
import { canRunAsAgent, resolveClaudeBinary } from "./agent-user.ts";
import type { CommandRunner } from "./command.ts";
import { defaultConfigPath, writeConfig } from "./config.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";
import type { Logger } from "./log.ts";

const TRAILING_SLASHES = /\/+$/;
const ENROLL_PATH = "/api/machines/enroll";
const SERVICE_UNIT = "harbourmaster";

export interface EnrollOptions {
  claudeBinary?: string;
  code: string;
  configPath?: string;
  fetch?: typeof fetch;
  log: Logger;
  run: CommandRunner;
  server: string;
}

const errorBodySchema = z.object({ error: z.string() });

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/** Whether the daemon's user has the systemd user unit installed. */
const isInstalledAsService = async (run: CommandRunner): Promise<boolean> => {
  const unit = await run(["systemctl", "--user", "cat", SERVICE_UNIT]);
  return unit.exitCode === 0;
};

const describeSingleUser = (claudeFound: boolean): string =>
  claudeFound
    ? "single_user is true because hm-agent is not set up, so Claude Code will run as this user. Run `harbourmaster install-service` before enrolling to have it run as hm-agent."
    : "single_user is true because no claude binary was found on the PATH, so Claude Code will run as this user.";

/** Returns the process exit code. Never logs the code or the credential. */
export const enrollCommand = async (
  options: EnrollOptions
): Promise<number> => {
  const { log, run } = options;
  const server = options.server.replace(TRAILING_SLASHES, "");
  if (!z.url().safeParse(server).success) {
    log.error(`the server is not a valid URL: ${options.server}`);
    return EXIT_FAILURE;
  }

  const claude = await resolveClaudeBinary(run, options.claudeBinary);
  const singleUser =
    claude === undefined || !(await canRunAsAgent(run, claude));

  const request = enrollRequestSchema.safeParse({
    code: options.code,
    singleUser,
  });
  if (!request.success) {
    log.error("the enrolment code is not valid");
    return EXIT_FAILURE;
  }

  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${server}${ENROLL_PATH}`, {
      body: JSON.stringify(request.data),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`could not reach ${server}: ${detail}`);
    return EXIT_FAILURE;
  }

  if (!response.ok) {
    const failure = errorBodySchema.safeParse(await readJson(response));
    const detail = failure.success ? `: ${failure.data.error}` : "";
    log.error(`enrolment failed with HTTP ${response.status}${detail}`);
    return EXIT_FAILURE;
  }

  const answer = enrollResponseSchema.safeParse(await readJson(response));
  if (!answer.success) {
    log.error(`${server} answered with something that is not an enrolment`);
    return EXIT_FAILURE;
  }

  const path = options.configPath ?? defaultConfigPath();
  try {
    writeConfig(
      {
        claudeBinary: claude ?? null,
        credential: answer.data.credential,
        machineId: answer.data.machineId,
        server,
        singleUser,
      },
      path
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`could not write the config at ${path}: ${detail}`);
    return EXIT_FAILURE;
  }

  log.info(`enrolled machine ${answer.data.machineId} at ${server}`);
  log.info(`single_user: ${singleUser}`);
  if (singleUser) {
    log.info(describeSingleUser(claude !== undefined));
  }
  log.info(`config written to ${path}`);
  const next = (await isInstalledAsService(run))
    ? `systemctl --user restart ${SERVICE_UNIT}`
    : "harbourmaster run";
  log.info(`next step: ${next}`);
  return EXIT_OK;
};
