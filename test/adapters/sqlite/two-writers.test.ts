import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { largeFlows } from "../../fixtures/save-flows-forever.js";

const script = fileURLToPath(new URL("../../fixtures/save-flows-forever.ts", import.meta.url));
const migrationsDir = fileURLToPath(
  new URL("../../../src/adapters/sqlite/migrations/", import.meta.url),
);

type Saver = {
  process: ChildProcess;
  firstSave: Promise<void>;
  output: () => string;
  diedEarly: () => boolean;
};

const startSaver = (path: string): Saver => {
  const child = spawn(process.execPath, ["--import", "tsx", script, path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let killed = false;
  let died = false;
  const firstSave = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("saved ")) resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      if (!killed) died = true;
      reject(new Error(`saver exited (${code ?? signal}) before its first save:\n${out}`));
    });
  });
  firstSave.catch(() => undefined);
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    killed = true;
    return kill(signal);
  };
  return { process: child, firstSave, output: () => out, diedEarly: () => died };
};

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

const fileCreated = (path: string, saver: Saver) =>
  new Promise<void>((resolve, reject) => {
    const look = () => {
      if (existsSync(path)) resolve();
      else if (saver.process.exitCode !== null || saver.process.signalCode !== null)
        reject(new Error(`saver exited before creating ${path}:\n${saver.output()}`));
      else setImmediate(look);
    };
    look();
  });

describe("two processes writing one database", () => {
  let folder: string;
  const savers: Saver[] = [];
  const opened: { close(): void }[] = [];

  const stop = async (saver: Saver) => {
    if (saver.process.exitCode === null && saver.process.signalCode === null) {
      saver.process.kill("SIGKILL");
    }
    await exited(saver.process);
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-two-writers-"));
  });

  afterEach(async () => {
    for (const saver of savers.splice(0)) await stop(saver);
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("applies each migration once when two processes open a fresh database at once", async () => {
    const expected = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

    for (let round = 0; round < 20; round++) {
      const path = join(folder, `round-${round}.db`);
      const saver = startSaver(path);
      savers.push(saver);
      await fileCreated(path, saver);

      const db = openDatabase({ path });
      opened.push(db);
      await saver.firstSave;
      await stop(saver);

      expect(saver.diedEarly(), `round ${round}: ${saver.output()}`).toBe(false);
      expect(
        (db.prepare("SELECT name FROM migrations ORDER BY name").all() as { name: string }[]).map(
          (row) => row.name,
        ),
        `round ${round}`,
      ).toEqual(expected);
    }
  }, 120_000);

  it("two processes saving the same blueprint at once both succeed with distinct versions", async () => {
    const path = join(folder, "flowdeck.db");
    const saver = startSaver(path);
    savers.push(saver);
    await saver.firstSave;

    const db = openDatabase({ path });
    opened.push(db);
    const store = new SqliteFlowStore({ db });
    const { a } = largeFlows();
    const failures: unknown[] = [];
    for (let save = 0; save < 30; save++) {
      try {
        store.save(a);
      } catch (error) {
        failures.push(error);
      }
    }
    await stop(saver);

    expect(failures).toEqual([]);
    expect(saver.diedEarly(), saver.output()).toBe(false);

    const readOnly = new Database(path, { readonly: true });
    opened.push(readOnly);
    const rows = readOnly.prepare("SELECT flow_id, version FROM flow_versions").all() as {
      flow_id: string;
      version: number;
    }[];
    const versions = rows.map((row) => row.version);

    expect(new Set(rows.map((row) => row.flow_id)).size).toBe(1);
    expect(new Set(versions).size).toBe(versions.length);
    expect(Math.max(...versions)).toBe(versions.length);
  }, 120_000);
});
