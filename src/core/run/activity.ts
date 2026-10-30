import { z } from "zod";
import { attribute, type NodeWindow } from "./attribution.js";

const base = { id: z.number().int(), nodeId: z.string(), at: z.number(), summary: z.string() };

export const activityEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("tool"), tool: z.string() }),
  z.object({
    ...base,
    kind: z.literal("subagent"),
    agentType: z.string(),
    state: z.enum(["running", "finished"]),
  }),
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
  kind: "PreToolUse" | "SubagentStop";
  payload: Record<string, unknown>;
};

export type FoldResult = { feed: ActivityFeed; changed: ActivityEntry | undefined };

const summaryLimit = 80;
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

function addEntry(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  payload: Record<string, unknown>,
): FoldResult {
  const unchanged = { feed, changed: undefined };
  const at = payload["flowdeck_hook_at"];
  if (payload["agent_id"] !== undefined || typeof at !== "number") return unchanged;
  const nodeId = attribute(windows, at);
  if (nodeId === undefined) return unchanged;
  const tool = String(payload["tool_name"]);
  const input = recordOf(payload["tool_input"]);
  const common = { id: feed.nextId, nodeId, at };
  const subagentType = input["subagent_type"];
  const changed: ActivityEntry =
    tool === "Agent"
      ? {
          ...common,
          kind: "subagent",
          agentType: typeof subagentType === "string" ? subagentType : defaultAgentType,
          summary: cut(firstString(input, ["description"])),
          state: "running",
        }
      : {
          ...common,
          kind: "tool",
          tool,
          summary: cut(firstString(input, ["file_path", "command", "pattern"])),
        };
  return { feed: { nextId: feed.nextId + 1, entries: [...feed.entries, changed] }, changed };
}

function finishSubagent(feed: ActivityFeed, payload: Record<string, unknown>): FoldResult {
  const agentType = payload["agent_type"];
  const running = feed.entries.find(
    (entry): entry is SubagentEntry =>
      entry.kind === "subagent" && entry.state === "running" && entry.agentType === agentType,
  );
  if (running === undefined) return { feed, changed: undefined };
  const changed: SubagentEntry = { ...running, state: "finished" };
  return {
    feed: { ...feed, entries: feed.entries.map((entry) => (entry === running ? changed : entry)) },
    changed,
  };
}

export const foldHookEvent = (
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  event: ActivityHookEvent,
): FoldResult =>
  event.kind === "PreToolUse"
    ? addEntry(feed, windows, event.payload)
    : finishSubagent(feed, event.payload);
