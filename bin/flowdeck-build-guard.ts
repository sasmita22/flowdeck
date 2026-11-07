import { isAbsolute, relative, resolve, sep } from "node:path";

type ToolCall = {
  hook_event_name?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: Record<string, unknown>;
};

const readOnlyTools = new Set(["Read", "Glob", "Grep", "Agent"]);
const editableFiles = new Set(["CLAUDE.md", "build-report.json"]);

function refusal(call: ToolCall, workspace: string): string | undefined {
  if (typeof call.tool_name === "string" && readOnlyTools.has(call.tool_name)) return undefined;
  if (call.tool_name !== "Edit") {
    return `A build session may only use Read, Edit, Glob, Grep and Agent, not ${String(call.tool_name)}`;
  }
  const input = call.tool_input ?? {};
  if (typeof input["old_string"] !== "string" || input["old_string"] === "") {
    return "A build session may only change existing text: old_string must not be empty";
  }
  if (typeof input["file_path"] !== "string") return "The Edit names no file_path";
  const base = typeof call.cwd === "string" ? call.cwd : workspace;
  const path = relative(workspace, resolve(base, input["file_path"]));
  const editable =
    !isAbsolute(path) && (editableFiles.has(path) || path.startsWith(`plugin${sep}`));
  return editable
    ? undefined
    : `A build session may only edit files under plugin/, CLAUDE.md and build-report.json in ${workspace}`;
}

function deny(reason: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

function answerPrompt(reason: string | undefined): void {
  const decision =
    reason === undefined ? { behavior: "allow" } : { behavior: "deny", message: reason };
  const output = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  process.stdout.write(JSON.stringify(output) + "\n");
}

const workspace = resolve(process.argv[2] ?? "");
const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => {
  let call: ToolCall;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ToolCall;
  } catch {
    return deny("The build guard could not read the tool call");
  }
  const reason = refusal(call, workspace);
  if (call.hook_event_name === "PermissionRequest") answerPrompt(reason);
  else if (reason !== undefined) deny(reason);
});
