import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { largeFlows } from "../../fixtures/save-flows-forever.js";

const script = fileURLToPath(new URL("../../fixtures/save-flows-forever.ts", import.meta.url));

const savedLines = (child: ChildProcess, wanted: number) =>
  new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.split("\n").filter((line) => line.startsWith("saved ")).length >= wanted) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      reject(new Error(`child exited (${code ?? signal}) before ${wanted} saves:\n${out}${err}`));
    });
  });

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

describe("SqliteFlowStore killed mid-save", () => {
  let folder: string;
  let path: string;
  let child: ChildProcess | undefined;
  const opened: { close(): void }[] = [];

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-flows-kill-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
    child = undefined;
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("leaves every saved version whole, either the old flow or the new, never a mix", async () => {
    const running = spawn(process.execPath, ["--import", "tsx", script, path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = running;
    await savedLines(running, 2);
    running.kill("SIGKILL");
    await exited(running);

    const { a, b } = largeFlows();
    const db = openDatabase({ path });
    opened.push(db);
    const loaded = new SqliteFlowStore({ db }).loadLatest();

    expect(loaded).not.toBeNull();
    expect([a, b]).toContainEqual(loaded?.flow);

    const raw = new Database(path, { readonly: true });
    opened.push(raw);
    const shapes = raw
      .prepare(
        `SELECT
           (SELECT count(*) FROM nodes n WHERE n.flow_id = v.flow_id AND n.version = v.version) AS nodes,
           (SELECT count(*) FROM wires w WHERE w.flow_id = v.flow_id AND w.version = v.version) AS wires
         FROM flow_versions v`,
      )
      .all();
    const whole = [
      { nodes: a.nodes.length, wires: a.wires.length },
      { nodes: b.nodes.length, wires: b.wires.length },
    ];

    expect(shapes.length).toBeGreaterThanOrEqual(2);
    for (const shape of shapes) expect(whole).toContainEqual(shape);
  }, 20_000);
});
