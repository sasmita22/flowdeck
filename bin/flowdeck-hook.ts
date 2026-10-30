import { connect } from "node:net";

const stdinCap = setTimeout(() => process.exit(0), 2000);

type Decision = { behavior: "allow" } | { behavior: "deny"; message: string };

const deadlineFlag = "--permission-deadline-ms=";

function forward(input: string): void {
  clearTimeout(stdinCap);
  setTimeout(() => process.exit(0), 1000);
  const socketPath = process.env["FLOWDECK_SOCK"];
  if (input.length === 0 || !socketPath) process.exit(0);
  const socket = connect(socketPath);
  socket.on("error", () => process.exit(0));
  socket.end(toLine(input), () => process.exit(0));
}

let decided = false;

function decide(decision: Decision): void {
  if (decided) return;
  decided = true;
  const output = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  process.stdout.write(JSON.stringify(output) + "\n", () => process.exit(0));
}

const deny = (message: string) => decide({ behavior: "deny", message });

function deadlineMs(): number | undefined {
  const flag = process.argv.find((arg) => arg.startsWith(deadlineFlag));
  const ms = Number(flag?.slice(deadlineFlag.length));
  return flag !== undefined && Number.isInteger(ms) && ms > 0 ? ms : undefined;
}

function decisionIn(line: string): Decision | undefined {
  try {
    const reply = JSON.parse(line) as { behavior?: unknown; message?: unknown } | null;
    if (reply?.behavior === "allow") return { behavior: "allow" };
    if (reply?.behavior === "deny" && typeof reply.message === "string") {
      return { behavior: "deny", message: reply.message };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function askFlowdeck(input: string): void {
  clearTimeout(stdinCap);
  const deadline = deadlineMs();
  if (deadline === undefined) return deny(`Flowdeck hook started without ${deadlineFlag}<ms>`);
  const socketPath = process.env["FLOWDECK_SOCK"];
  if (!socketPath) return deny("FLOWDECK_SOCK is not set, so no run can answer");
  setTimeout(() => deny(`Flowdeck did not answer within ${deadline} ms`), deadline);
  const socket = connect(socketPath);
  socket.on("error", (error) => deny(`Flowdeck could not be reached: ${error.message}`));
  socket.setEncoding("utf8");
  let reply = "";
  socket.on("data", (chunk: string) => {
    reply += chunk;
    const end = reply.indexOf("\n");
    if (end === -1) return;
    const line = reply.slice(0, end);
    decide(
      decisionIn(line) ?? {
        behavior: "deny",
        message: `Flowdeck sent an unreadable reply: ${line}`,
      },
    );
  });
  socket.on("close", () => deny("Flowdeck closed the connection without an answer"));
  socket.write(toLine(input));
}

const stamped = (value: unknown): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value, flowdeck_hook_at: Date.now() }
    : value;

function toLine(input: string): string {
  try {
    return JSON.stringify(stamped(JSON.parse(input))) + "\n";
  } catch {
    return input.replace(/[\r\n]/g, " ") + "\n";
  }
}

function isPermissionRequest(input: string): boolean {
  try {
    const payload = JSON.parse(input) as { hook_event_name?: unknown } | null;
    return payload?.hook_event_name === "PermissionRequest";
  } catch {
    return false;
  }
}

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString("utf8");
  if (isPermissionRequest(input)) askFlowdeck(input);
  else forward(input);
});
process.stdin.on("error", () => process.exit(0));
