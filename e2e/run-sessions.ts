import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { killTmux } from "./blueprint-pane.js";

const runSessionName = /^fd-run-[0-9a-f]{8}$/;

const runSessionNames = (home: string): string[] => {
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

export const killRunSessions = async (home: string) => {
  for (const name of runSessionNames(home)) {
    if (runSessionName.test(name)) await killTmux(name);
  }
};
