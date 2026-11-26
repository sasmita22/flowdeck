import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { flowdeckSessionNames, sessionSocketPath } from "../src/adapters/tmux/flowdeck-sessions.js";
import { killTmux } from "./blueprint-pane.js";

type Options = { timeoutMs?: number };

const run = promisify(execFile);

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not answer in ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const realOr = (path: string) => realpath(path).catch(() => path);

const listHome = async (home: string, timeoutMs: number) => {
  const real = resolve(await realOr(home));
  if (!isAbsolute(home) || real === "/") throw new Error(`Not a test home: "${home}"`);
  const root = `${real}/`;
  const found: string[] = [];
  const failures: string[] = [];
  for (const name of await flowdeckSessionNames()) {
    const socket = await withTimeout(
      sessionSocketPath(name).catch(() => undefined),
      timeoutMs,
      `tmux session ${name}`,
    ).catch((error: Error) => {
      failures.push(error.message);
      return undefined;
    });
    if (socket === undefined) continue;
    if (`${await realOr(dirname(dirname(socket)))}/`.startsWith(root)) found.push(name);
  }
  return { found, failures };
};

const recordedSessionNames = (home: string): string[] => {
  const path = join(home, "flowdeck.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT tmux_name FROM run_sessions").all() as { tmux_name: string }[]).map(
      ({ tmux_name }) => tmux_name,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "no such table: run_sessions") return [];
    throw error;
  } finally {
    db.close();
  }
};

const answers = (name: string) =>
  run("tmux", ["-L", name, "list-sessions"]).then(
    () => true,
    () => false,
  );

const removeDeadSockets = async (names: Set<string>, timeoutMs: number) => {
  const failures: string[] = [];
  const folder = join(process.env["TMUX_TMPDIR"] || "/tmp", `tmux-${process.getuid?.()}`);
  for (const name of await flowdeckSessionNames()) {
    if (!names.has(name)) continue;
    const alive = await withTimeout(answers(name), timeoutMs, `tmux session ${name}`).catch(
      (error: Error) => {
        failures.push(error.message);
        return true;
      },
    );
    if (!alive) await rm(join(folder, name), { force: true });
  }
  return failures;
};

export const sessionsOfHome = async (home: string, { timeoutMs = 5_000 }: Options = {}) => {
  const { found, failures } = await listHome(home, timeoutMs);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return found;
};

export const endSessionsOfHome = async (home: string, { timeoutMs = 5_000 }: Options = {}) => {
  const listed = await listHome(home, timeoutMs);
  const failures = [...listed.failures];
  for (const name of listed.found) {
    await withTimeout(killTmux(name), timeoutMs, `tmux session ${name}`).catch((error: Error) =>
      failures.push(error.message),
    );
  }
  const ours = new Set([...recordedSessionNames(home), ...listed.found]);
  failures.push(...(await removeDeadSockets(ours, timeoutMs)));
  const relisted = await listHome(home, timeoutMs);
  failures.push(...relisted.failures);
  if (relisted.found.length > 0) {
    failures.push(`${home} still has tmux sessions running: ${relisted.found.join(", ")}`);
  }
  if (failures.length > 0) throw new Error([...new Set(failures)].join("\n"));
};
