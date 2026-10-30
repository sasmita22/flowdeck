import { spawn } from "node:child_process";
import { lstat, mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const maxSocketPath = 104;

export function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(error.code as string);
}

export async function makeSocketPath(): Promise<{ dir: string; socketPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fd-"));
  const socketPath = join(dir, "s.sock");
  if (socketPath.length > maxSocketPath) {
    throw new Error(`Socket path "${socketPath}" is longer than ${maxSocketPath} characters`);
  }
  return { dir, socketPath };
}

export type HookRun = { code: number | null; stdout: string; ms: number };

export function runHook(options: {
  socketPath?: string;
  stdin: string | Buffer;
  env?: NodeJS.ProcessEnv;
  keepStdinOpen?: boolean;
  args?: string[];
}): Promise<HookRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["FLOWDECK_SOCK"];
  if (options.socketPath !== undefined) env["FLOWDECK_SOCK"] = options.socketPath;
  Object.assign(env, options.env);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [hookPath, ...(options.args ?? [])], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    let ms = 0;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stdin.on("error", (error) => {
      if (!hasCode(error, "EPIPE")) reject(error);
    });
    child.on("error", reject);
    child.on("exit", () => {
      ms = performance.now() - started;
      child.stdin.destroy();
    });
    child.on("close", (code) => resolve({ code, stdout, ms }));
    if (options.keepStdinOpen) child.stdin.write(options.stdin);
    else child.stdin.end(options.stdin);
  });
}

const listenThenReport = `
const net = process.getBuiltinModule("node:net");
net.createServer().listen(process.argv[1], () => console.log("ready"));
`;

export async function makeStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", listenThenReport, socketPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Stale socket server exited early (${code})`)));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (chunk.includes("ready")) resolve();
    });
  });
  child.kill("SIGKILL");
  await exited;
  if (!(await lstat(socketPath)).isSocket()) {
    throw new Error(`"${socketPath}" is not a socket after its server was killed`);
  }
  const refused = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.on("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.on("error", (error) => (hasCode(error, "ECONNREFUSED") ? resolve(true) : reject(error)));
  });
  if (!refused) throw new Error(`"${socketPath}" did not refuse a connection`);
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  describe: () => string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(describe());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
