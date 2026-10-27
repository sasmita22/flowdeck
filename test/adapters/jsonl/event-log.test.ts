import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../../src/adapters/jsonl/event-log.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";

const time = new Date("2026-10-27T12:00:00.000Z");
const now = () => time;
const runId = "run-1";
const watched = "s1";
const other = "s2";

function event(
  kind: HookEventKind,
  payload: Record<string, unknown> = {},
  sessionId = watched,
): HookEvent {
  return { kind, sessionId, payload: { session_id: sessionId, ...payload } };
}

function line(fields: {
  kind: HookEventKind;
  tool_name?: string;
  agent_type?: string;
  agent_id?: string;
}) {
  return {
    run_id: runId,
    session_id: watched,
    kind: fields.kind,
    tool_name: fields.tool_name ?? null,
    agent_type: fields.agent_type ?? null,
    agent_id: fields.agent_id ?? null,
    time: time.toISOString(),
  };
}

describe("EventLog", () => {
  let tmp: string;
  let path: string;
  let events: FakeEventSource;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fd-event-log-"));
    path = join(tmp, "events.jsonl");
    events = new FakeEventSource();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function readText(): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  async function readLines(): Promise<unknown[]> {
    const text = await readText();
    return text
      .split("\n")
      .slice(0, -1)
      .map((entry) => JSON.parse(entry) as unknown);
  }

  function watch() {
    return new EventLog({ events, path, runId, now }).watch(watched);
  }

  it("logs a PreToolUse event with its tool name", async () => {
    watch();

    events.publish(event("PreToolUse", { tool_name: "Read" }));

    expect(await readLines()).toStrictEqual([line({ kind: "PreToolUse", tool_name: "Read" })]);
  });

  it("logs a PostToolUse event with its tool name", async () => {
    watch();

    events.publish(event("PostToolUse", { tool_name: "Bash" }));

    expect(await readLines()).toStrictEqual([line({ kind: "PostToolUse", tool_name: "Bash" })]);
  });

  it("logs a Stop event with null tool and agent fields", async () => {
    watch();

    events.publish(event("Stop", { last_assistant_message: "OK" }));

    expect(await readLines()).toStrictEqual([line({ kind: "Stop" })]);
  });

  it("logs a SubagentStop event with its agent type and id", async () => {
    watch();

    events.publish(event("SubagentStop", { agent_type: "general-purpose", agent_id: "agent-1" }));

    expect(await readLines()).toStrictEqual([
      line({ kind: "SubagentStop", agent_type: "general-purpose", agent_id: "agent-1" }),
    ]);
  });

  it("logs an internal agent's SubagentStop with an empty agent type and a null id", async () => {
    watch();

    events.publish(event("SubagentStop", { agent_type: "" }));

    expect(await readLines()).toStrictEqual([line({ kind: "SubagentStop", agent_type: "" })]);
  });

  it("does not log another session's events", async () => {
    watch();

    events.publish(event("PreToolUse", { tool_name: "Read" }, other));
    events.publish(event("Stop", {}, watched));

    expect(await readLines()).toStrictEqual([line({ kind: "Stop" })]);
  });

  it("logs nothing after the returned function is called", async () => {
    const unwatch = watch();
    events.publish(event("Stop"));

    unwatch();
    events.publish(event("PreToolUse", { tool_name: "Read" }));
    events.publish(event("PostToolUse", { tool_name: "Read" }));
    events.publish(event("SubagentStop", { agent_type: "general-purpose", agent_id: "agent-1" }));
    events.publish(event("Stop"));

    expect(await readLines()).toStrictEqual([line({ kind: "Stop" })]);
  });

  it("keeps the first instance's line when a second instance appends to the same file", async () => {
    const first = new FakeEventSource();
    const second = new FakeEventSource();
    new EventLog({ events: first, path, runId, now }).watch(watched);
    first.publish(event("PreToolUse", { tool_name: "Read" }));

    new EventLog({ events: second, path, runId, now }).watch(watched);
    second.publish(event("Stop"));

    expect(await readLines()).toStrictEqual([
      line({ kind: "PreToolUse", tool_name: "Read" }),
      line({ kind: "Stop" }),
    ]);
  });

  it("writes events published back to back as lines in delivery order", async () => {
    watch();

    events.publish(event("PreToolUse", { tool_name: "Read" }));
    events.publish(event("PostToolUse", { tool_name: "Read" }));

    const text = await readText();
    expect(text.split("\n")).toHaveLength(3);
    expect(text.endsWith("\n")).toBe(true);
    expect(await readLines()).toStrictEqual([
      line({ kind: "PreToolUse", tool_name: "Read" }),
      line({ kind: "PostToolUse", tool_name: "Read" }),
    ]);
  });

  it("creates the log's parent folder when it does not exist", async () => {
    path = join(tmp, "runs", runId, "events.jsonl");
    watch();

    events.publish(event("Stop"));

    expect(await readLines()).toStrictEqual([line({ kind: "Stop" })]);
  });
});
