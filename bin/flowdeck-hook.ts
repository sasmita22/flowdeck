import { connect } from "node:net";

const stdinCap = setTimeout(() => process.exit(0), 2000);

function forward(input: string): void {
  clearTimeout(stdinCap);
  setTimeout(() => process.exit(0), 1000);
  const socketPath = process.env["FLOWDECK_SOCK"];
  if (input.length === 0 || !socketPath) process.exit(0);
  const socket = connect(socketPath);
  socket.on("error", () => process.exit(0));
  socket.end(toLine(input), () => process.exit(0));
}

function toLine(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input)) + "\n";
  } catch {
    return input.replace(/[\r\n]/g, " ") + "\n";
  }
}

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => forward(Buffer.concat(chunks).toString("utf8")));
process.stdin.on("error", () => process.exit(0));
