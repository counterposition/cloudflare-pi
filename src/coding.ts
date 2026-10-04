/**
 * Coding extension: the four real Pi coding tools (read, write, edit, bash) with their names,
 * schemas, metadata, and replay policies preserved, wrapped so every execution runs through the
 * session's WorkspaceManager. Mutating tools (write, edit, bash) checkpoint quiesced workspace
 * state after their effects and before the harness publishes a successful tool receipt; read
 * tools run without claiming the workspace's serial mutating boundary.
 *
 * The tool prompt states the session's Linux sandbox policy: only /workspace/project persists,
 * there are no credentials in the sandbox, and background daemons are not supported — long-lived
 * processes are terminated by the bounded quiescence sweep before every backup or restore.
 */
import { defineExtension, section, wrapTool, type Extension } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { WorkspaceManager } from "./workspace";

/** Directory that survives checkpoints and restores; everything else is temporary. */
export const WORKSPACE_CWD = "/workspace/project";

const WORKSPACE_POLICY_SECTION = [
  `You are a coding assistant working in the project directory ${WORKSPACE_CWD}.`,
  `Only files under ${WORKSPACE_CWD} persist across sessions; everything outside it, including /tmp, is temporary and may disappear between tool calls.`,
  "The sandbox holds no credentials and needs none: never ask for or expect API keys, tokens, or passwords.",
  "Background daemons are not supported. Do not start servers or long-lived processes that outlive the tool call that started them; they are terminated before checkpoints and restores.",
].join("\n");

/**
 * Build the session's coding extension around one workspace. The wrapped `execute` forwards the
 * original arguments and execution API unchanged — the wrapper only scopes execution to the
 * workspace's serial boundary, which owns container quiescence and checkpointing.
 */
export function createCodingExtension(workspace: WorkspaceManager): Extension {
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();
  const bash = createBashTool();

  return defineExtension({
    name: "coding",
    tools: [read, write, edit, bash],
    sections: [section("workspace", () => WORKSPACE_POLICY_SECTION)],
    wraps: [
      wrapTool(read, (tool) => ({
        ...tool,
        execute: (args, api, context) =>
          workspace.runTool(false, () => tool.execute(args, api, context)),
      })),
      wrapTool(write, (tool) => ({
        ...tool,
        execute: (args, api, context) =>
          workspace.runTool(true, () => tool.execute(args, api, context)),
      })),
      wrapTool(edit, (tool) => ({
        ...tool,
        execute: (args, api, context) =>
          workspace.runTool(true, () => tool.execute(args, api, context)),
      })),
      wrapTool(bash, (tool) => ({
        ...tool,
        execute: (args, api, context) =>
          workspace.runTool(true, () => tool.execute(args, api, context)),
      })),
    ],
  });
}
