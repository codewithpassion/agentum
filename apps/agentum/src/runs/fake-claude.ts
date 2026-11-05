// Only tests launch this executable. No SDK or real Claude process is used.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const messages = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
let stage = 0;
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (stage === 0) {
    if (
      frame.request.subtype !== "initialize" ||
      frame.request.hooks.PreToolUse[0].timeout !== 90_000 ||
      !frame.request.appendSystemPrompt.includes("Your files live") ||
      process.env.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts" ||
      process.env.CLAUDECODE ||
      !process.argv.includes("--permission-prompt-tool")
    ) {
      process.exit(21);
    }
    send({
      response: {
        request_id: frame.request_id,
        response: {},
        subtype: "success",
      },
      type: "control_response",
    });
    stage += 1;
  } else if (stage === 1) {
    if (frame.request.subtype !== "mcp_set_servers") {
      process.exit(22);
    }
    send({
      response: {
        request_id: frame.request_id,
        response: {},
        subtype: "success",
      },
      type: "control_response",
    });
    stage += 1;
  } else if (stage === 2) {
    if (frame.type !== "user") {
      process.exit(23);
    }
    if (frame.message.content === "many") {
      for (let index = 0; index < 205; index += 1) {
        send({
          message: { content: [{ text: `message ${index}`, type: "text" }] },
          type: "assistant",
        });
      }
      send(messages.at(-1));
      break;
    }
    if (frame.message.content === "hold") {
      continue;
    }
    if (frame.message.content === "fail") {
      send({
        errors: [],
        session_id: "session",
        subtype: "error_max_turns",
        type: "result",
        usage: {},
      });
      break;
    }
    if (frame.message.content === "cancel-control") {
      send({
        request: {
          callback_id: "hook_0",
          input: {
            hook_event_name: "PreToolUse",
            tool_input: {},
            tool_name: "Bash",
            tool_use_id: "cancelled",
          },
          subtype: "hook_callback",
        },
        request_id: "cancel-me",
        type: "control_request",
      });
      send({ request_id: "cancel-me", type: "control_cancel_request" });
      stage = 6;
      continue;
    }
    if (frame.message.content === "controls") {
      send({
        request: { subtype: "future" },
        request_id: "unknown",
        type: "control_request",
      });
      stage += 1;
      continue;
    }
    for (const message of messages) {
      send(message);
    }
    break;
  } else if (stage === 3) {
    if (frame.response.subtype !== "error") {
      process.exit(24);
    }
    send({
      request: {
        input: {},
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "t",
      },
      request_id: "can",
      type: "control_request",
    });
    stage += 1;
  } else if (stage === 4) {
    if (frame.response.response.behavior !== "allow") {
      process.exit(25);
    }
    send({
      request: {
        callback_id: "hook_0",
        input: {
          hook_event_name: "PreToolUse",
          tool_input: { command: "echo yes" },
          tool_name: "Bash",
          tool_use_id: "t",
        },
        subtype: "hook_callback",
      },
      request_id: "hook",
      type: "control_request",
    });
    stage += 1;
  } else if (stage === 6) {
    if (
      frame.response.response.hookSpecificOutput.permissionDecision !== "deny"
    ) {
      process.exit(27);
    }
    for (const message of messages) {
      send(message);
    }
    break;
  } else if (stage === 5) {
    if (
      frame.response.response.hookSpecificOutput.permissionDecision !== "allow"
    ) {
      process.exit(26);
    }
    for (const message of messages) {
      send(message);
    }
    break;
  }
}
