import { z } from "zod";
import { agentCallOf } from "./agent-calls.js";
import { attribute, type NodeWindow } from "./attribution.js";
import { plainReason } from "./failure.js";
import type { RunEvent } from "./run-events.js";

const base = { id: z.number().int(), nodeId: z.string(), at: z.number(), summary: z.string() };

export const activityEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("tool"), tool: z.string(), path: z.string().optional() }),
  z.object({
    ...base,
    kind: z.literal("subagent"),
    agentType: z.string(),
    state: z.enum(["running", "finished"]),
    toolUseId: z.string().optional(),
    agentId: z.string().optional(),
  }),
  z.object({ ...base, kind: z.literal("turn") }),
  z.object({ ...base, kind: z.literal("failure") }),
  z.object({ ...base, kind: z.literal("context") }),
  z.object({ ...base, kind: z.literal("pr"), url: z.string() }),
  z.object({ ...base, kind: z.literal("kept") }),
]);

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const activityUpdateSchema = z.object({ runId: z.string(), entry: activityEntrySchema });

export const activityFeedSchema = z.object({
  runId: z.string(),
  entries: z.array(activityEntrySchema),
});

export type ActivityFeed = { nextId: number; entries: ActivityEntry[] };

export const emptyFeed: ActivityFeed = { nextId: 1, entries: [] };

export type ActivityHookEvent = {
  kind: "PreToolUse" | "PostToolUse" | "SubagentStop";
  payload: Record<string, unknown>;
};

export const feedOf = (entries: readonly ActivityEntry[]): ActivityFeed => ({
  nextId: entries.reduce((top, entry) => Math.max(top, entry.id), 0) + 1,
  entries: [...entries],
});

export type FoldResult = { feed: ActivityFeed; changed: ActivityEntry | undefined };

const summaryLimit = 80;
const writeTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const pullRequestUrl = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const defaultAgentType = "general-purpose";

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const cut = (text: string) =>
  text.length > summaryLimit ? `${text.slice(0, summaryLimit - 1)}…` : text;

const firstString = (input: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
};

type SubagentEntry = Extract<ActivityEntry, { kind: "subagent" }>;

export type WorkingPlace = { cwd: string; home?: string };

const within = (path: string, folder: string) =>
  path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

export function shownPath(path: string, { cwd, home }: WorkingPlace): string {
  if (!path.startsWith("/")) return path;
  if (within(path, cwd)) return path.slice(cwd.replace(/\/$/, "").length + 1);
  const outside =
    home !== undefined && within(path, home)
      ? `~${path.slice(home.replace(/\/$/, "").length)}`
      : path;
  return `outside the working folder: ${outside}`;
}

function addEntry(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  payload: Record<string, unknown>,
  place: WorkingPlace | undefined,
): FoldResult {
  const unchanged = { feed, changed: undefined };
  const at = payload["flowdeck_hook_at"];
  if (payload["agent_id"] !== undefined || typeof at !== "number") return unchanged;
  const tool = String(payload["tool_name"]);
  const input = recordOf(payload["tool_input"]);
  const subagentType = input["subagent_type"];
  const call = agentCallOf({ kind: "PreToolUse", payload });
  const nodeId = attribute(windows, at, call?.nodeId);
  if (nodeId === undefined) return unchanged;
  const common = { id: feed.nextId, nodeId, at };
  const changed: ActivityEntry =
    tool === "Agent"
      ? {
          ...common,
          kind: "subagent",
          agentType: typeof subagentType === "string" ? subagentType : defaultAgentType,
          summary: cut(firstString(input, ["description"])),
          state: "running",
          ...(call?.toolUseId === undefined ? {} : { toolUseId: call.toolUseId }),
        }
      : {
          ...common,
          kind: "tool",
          tool,
          summary: cut(firstString(input, ["file_path", "command", "pattern"])),
          ...(writeTools.has(tool) && typeof input["file_path"] === "string"
            ? {
                path:
                  place === undefined ? input["file_path"] : shownPath(input["file_path"], place),
              }
            : {}),
        };
  return added(feed, changed);
}

const added = (feed: ActivityFeed, changed: ActivityEntry): FoldResult => ({
  feed: { nextId: feed.nextId + 1, entries: [...feed.entries, changed] },
  changed,
});

function addPullRequest(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  payload: Record<string, unknown>,
): FoldResult {
  const unchanged = { feed, changed: undefined };
  const at = payload["flowdeck_hook_at"];
  const command = recordOf(payload["tool_input"])["command"];
  if (typeof at !== "number" || typeof command !== "string" || !command.includes("gh pr create")) {
    return unchanged;
  }
  const stdout = recordOf(payload["tool_response"])["stdout"];
  const url = typeof stdout === "string" ? pullRequestUrl.exec(stdout)?.[0] : undefined;
  const nodeId = attribute(windows, at);
  if (url === undefined || nodeId === undefined) return unchanged;
  if (feed.entries.some((entry) => entry.kind === "pr" && entry.url === url)) return unchanged;
  return added(feed, { id: feed.nextId, nodeId, at, kind: "pr", url, summary: url });
}

const replaced = (feed: ActivityFeed, old: ActivityEntry, changed: ActivityEntry): FoldResult => ({
  feed: { ...feed, entries: feed.entries.map((entry) => (entry === old ? changed : entry)) },
  changed,
});

const runningWhere = (feed: ActivityFeed, matches: (entry: SubagentEntry) => boolean) =>
  feed.entries.find(
    (entry): entry is SubagentEntry =>
      entry.kind === "subagent" && entry.state === "running" && matches(entry),
  );

function finishCall(feed: ActivityFeed, payload: Record<string, unknown>): FoldResult {
  const call = agentCallOf({ kind: "PostToolUse", payload });
  const toolUseId = call?.toolUseId;
  const running =
    toolUseId === undefined
      ? undefined
      : runningWhere(feed, (entry) => entry.toolUseId === toolUseId);
  if (call === undefined || running === undefined) return { feed, changed: undefined };
  return replaced(feed, running, {
    ...running,
    state: "finished",
    ...(call.nodeId === undefined ? {} : { nodeId: call.nodeId }),
    ...(call.agentId === undefined ? {} : { agentId: call.agentId }),
  });
}

function finishSubagent(feed: ActivityFeed, payload: Record<string, unknown>): FoldResult {
  const call = agentCallOf({ kind: "SubagentStop", payload });
  const agentId = payload["agent_id"];
  if (call?.background === true || typeof agentId !== "string") return { feed, changed: undefined };
  const running = runningWhere(feed, (entry) => entry.agentId === agentId);
  return running === undefined
    ? { feed, changed: undefined }
    : replaced(feed, running, { ...running, state: "finished" });
}

export function foldHookEvent(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  event: ActivityHookEvent,
  place?: WorkingPlace,
): FoldResult {
  switch (event.kind) {
    case "PreToolUse":
      return addEntry(feed, windows, event.payload, place);
    case "PostToolUse":
      return event.payload["tool_name"] === "Agent" && event.payload["agent_id"] === undefined
        ? finishCall(feed, event.payload)
        : addPullRequest(feed, windows, event.payload);
    case "SubagentStop":
      return finishSubagent(feed, event.payload);
  }
}

export function foldNodeEvent(
  feed: ActivityFeed,
  { nodeId, at, turnNodes }: { nodeId: string; at: number; turnNodes: ReadonlySet<string> },
  event: RunEvent,
): FoldResult {
  const common = { id: feed.nextId, nodeId, at };
  if (event.kind === "failed") {
    return added(feed, {
      ...common,
      kind: "failure",
      summary: plainReason(nodeId, event.payload.message),
    });
  }
  if (event.kind === "compacted") {
    const thousands = Math.round(event.payload.tokens / 1000);
    return added(feed, {
      ...common,
      kind: "context",
      summary: `Context compacted at ${thousands}k tokens`,
    });
  }
  if (event.kind !== "done" || !turnNodes.has(nodeId)) return { feed, changed: undefined };
  const message = event.payload?.stopMessage?.trim() ?? "";
  return added(feed, {
    ...common,
    kind: "turn",
    summary: message === "" ? "Turn ended" : cut(message),
  });
}
