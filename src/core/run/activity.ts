import { z } from "zod";
import { agentCallOf } from "./agent-calls.js";
import { attribute, type NodeWindow } from "./attribution.js";
import { plainReason } from "./failure.js";
import type { RunEvent } from "./run-events.js";
import type { StepTextField } from "./store.js";

const base = { id: z.number().int(), nodeId: z.string(), at: z.number(), summary: z.string() };

export const activityEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("tool"),
    tool: z.string(),
    path: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    result: z.enum(["ok", "error"]).optional(),
    durationMs: z.number().optional(),
    agentId: z.string().optional(),
    childAgentId: z.string().optional(),
    toolUseId: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("subagent"),
    agentType: z.string(),
    state: z.enum(["running", "finished"]),
    toolUseId: z.string().optional(),
    agentId: z.string().optional(),
    report: z.string().optional(),
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

export type ActivityHookEvent = {
  kind: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "SubagentStop";
  payload: Record<string, unknown>;
};

export const feedOf = (entries: readonly ActivityEntry[]): ActivityFeed => ({
  nextId: entries.reduce((top, entry) => Math.max(top, entry.id), 0) + 1,
  entries: [...entries],
});

export const firstAtOrAfter = (entries: readonly ActivityEntry[], id: number): number => {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((entries[middle]?.id ?? id) < id) low = middle + 1;
    else high = middle;
  }
  return low;
};

export type CutText = { entryId: number; field: StepTextField; text: string };

export type FoldResult = {
  feed: ActivityFeed;
  changed: readonly ActivityEntry[];
  cut: readonly CutText[];
};

const summaryLimit = 80;
const previewCap = 2_000;
const cutMarker = /\n… cut, \d+ more characters$/;

export const previewOf = (text: string): string =>
  text.length > previewCap
    ? `${text.slice(0, previewCap)}\n… cut, ${text.length - previewCap} more characters`
    : text;

export const isCut = (text: string): boolean => cutMarker.test(text);

const cutOf = (entryId: number, field: StepTextField, text: string | undefined): CutText[] =>
  text !== undefined && text.length > previewCap ? [{ entryId, field, text }] : [];

const keeping = (result: FoldResult, cut: readonly CutText[]): FoldResult => ({
  ...result,
  cut: [...result.cut, ...cut],
});
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
type ToolEntry = Extract<ActivityEntry, { kind: "tool" }>;

const unchangedFeed = (feed: ActivityFeed): FoldResult => ({ feed, changed: [], cut: [] });

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

const linkedNode = (feed: ActivityFeed, agentId: string): string | undefined =>
  feed.entries.find(
    (entry) =>
      (entry.kind === "subagent" && entry.agentId === agentId) ||
      (entry.kind === "tool" && entry.childAgentId === agentId),
  )?.nodeId;

const runningUnlinked = (feed: ActivityFeed): SubagentEntry[] =>
  feed.entries.filter(
    (entry): entry is SubagentEntry =>
      entry.kind === "subagent" && entry.state === "running" && entry.agentId === undefined,
  );

const onlyOfType = (
  feed: ActivityFeed,
  calls: readonly SubagentEntry[],
  agentType: unknown,
): SubagentEntry | undefined => {
  if (nestedAgentRunning(feed)) return undefined;
  const [only, ...others] = calls.filter((entry) => entry.agentType === agentType);
  return others.length === 0 ? only : undefined;
};

function subagentStepNode(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  agentId: string,
  agentType: unknown,
  at: number,
): string | undefined {
  const linked = linkedNode(feed, agentId);
  if (linked !== undefined) return linked;
  const calls = runningUnlinked(feed).filter(
    (call) => attribute(windows, at, call.nodeId) === call.nodeId || call.agentType === agentType,
  );
  const [only, ...others] = calls;
  if (only === undefined) return undefined;
  if (others.length === 0) return only.nodeId;
  return onlyOfType(feed, calls, agentType)?.nodeId ?? attribute(windows, at);
}

const agentsUnder = (feed: ActivityFeed, agentId: string): ReadonlySet<string> => {
  const agents = new Set([agentId]);
  for (const agent of agents) {
    for (const entry of feed.entries) {
      if (entry.kind === "tool" && entry.agentId === agent && entry.childAgentId !== undefined) {
        agents.add(entry.childAgentId);
      }
    }
  }
  return agents;
};

function recredit(feed: ActivityFeed, agentId: string, nodeId: string): FoldResult {
  const agents = agentsUnder(feed, agentId);
  const entries = feed.entries.map((entry) =>
    entry.kind === "tool" &&
    entry.agentId !== undefined &&
    agents.has(entry.agentId) &&
    entry.nodeId !== nodeId
      ? { ...entry, nodeId }
      : entry,
  );
  return {
    feed: { ...feed, entries },
    changed: entries.filter((entry, index) => entry !== feed.entries[index]),
    cut: [],
  };
}

const followedBy = (first: FoldResult, next: (feed: ActivityFeed) => FoldResult): FoldResult => {
  const second = next(first.feed);
  return {
    feed: second.feed,
    changed: [...first.changed, ...second.changed],
    cut: [...first.cut, ...second.cut],
  };
};

const openWindowOf = (windows: readonly NodeWindow[], nodeId: string | undefined) =>
  windows.find((window) => window.nodeId === nodeId && window.endedAt === undefined)?.nodeId;

function addEntry(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  payload: Record<string, unknown>,
  place: WorkingPlace | undefined,
): FoldResult {
  const unchanged = unchangedFeed(feed);
  const at = payload["flowdeck_hook_at"];
  if (typeof at !== "number") return unchanged;
  const agentId = payload["agent_id"];
  const inSubagent = typeof agentId === "string";
  const tool = String(payload["tool_name"]);
  const input = recordOf(payload["tool_input"]);
  const subagentType = input["subagent_type"];
  const call = agentCallOf({ kind: "PreToolUse", payload });
  const nodeId = inSubagent
    ? subagentStepNode(feed, windows, agentId, payload["agent_type"], at)
    : (openWindowOf(windows, call?.nodeId) ?? attribute(windows, at, call?.nodeId));
  if (nodeId === undefined) return unchanged;
  const common = { id: feed.nextId, nodeId, at };
  if (tool === "Agent" && !inSubagent) {
    return added(feed, {
      ...common,
      kind: "subagent",
      agentType: typeof subagentType === "string" ? subagentType : defaultAgentType,
      summary: cut(firstString(input, ["description"])),
      state: "running",
      ...(call?.toolUseId === undefined ? {} : { toolUseId: call.toolUseId }),
    });
  }
  const inputText = JSON.stringify(payload["tool_input"]) as string | undefined;
  const toolUseId = payload["tool_use_id"];
  const step = added(feed, {
    ...common,
    kind: "tool",
    tool,
    summary: cut(firstString(input, ["file_path", "command", "pattern"])),
    ...(writeTools.has(tool) && typeof input["file_path"] === "string"
      ? {
          path: place === undefined ? input["file_path"] : shownPath(input["file_path"], place),
        }
      : {}),
    ...(inputText === undefined ? {} : { input: previewOf(inputText) }),
    ...(inSubagent ? { agentId } : {}),
    ...(typeof toolUseId === "string" ? { toolUseId } : {}),
  });
  return keeping(step, cutOf(common.id, "input", inputText));
}

const added = (feed: ActivityFeed, changed: ActivityEntry): FoldResult => ({
  feed: { ...feed, nextId: feed.nextId + 1, entries: [...feed.entries, changed] },
  changed: [changed],
  cut: [],
});

function addPullRequest(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  payload: Record<string, unknown>,
): FoldResult {
  const unchanged = unchangedFeed(feed);
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
  changed: [changed],
  cut: [],
});

const runningWhere = (feed: ActivityFeed, matches: (entry: SubagentEntry) => boolean) =>
  feed.entries.find(
    (entry): entry is SubagentEntry =>
      entry.kind === "subagent" && entry.state === "running" && matches(entry),
  );

export const reportOf = (payload: Record<string, unknown>): string | undefined => {
  const content = recordOf(payload["tool_response"])["content"];
  const texts = (Array.isArray(content) ? (content as unknown[]) : []).flatMap((part) => {
    const text = recordOf(part)["text"];
    return typeof text === "string" ? [text] : [];
  });
  return texts.length === 0 ? undefined : texts.join("\n");
};

function finishCall(feed: ActivityFeed, payload: Record<string, unknown>): FoldResult {
  const call = agentCallOf({ kind: "PostToolUse", payload });
  const toolUseId = call?.toolUseId;
  const running =
    toolUseId === undefined
      ? undefined
      : runningWhere(feed, (entry) => entry.toolUseId === toolUseId);
  if (call === undefined || running === undefined) return unchangedFeed(feed);
  const report = reportOf(payload);
  const finished: SubagentEntry = {
    ...running,
    state: "finished",
    ...(call.nodeId === undefined ? {} : { nodeId: call.nodeId }),
    ...(call.agentId === undefined ? {} : { agentId: call.agentId }),
    ...(report === undefined ? {} : { report: previewOf(report) }),
  };
  const { agentId } = call;
  const done = keeping(replaced(feed, running, finished), cutOf(running.id, "report", report));
  return agentId === undefined
    ? done
    : followedBy(done, (next) => recredit(next, agentId, finished.nodeId));
}

const hasSteps = (feed: ActivityFeed, agentId: string) =>
  feed.entries.some((entry) => entry.kind === "tool" && entry.agentId === agentId);

const nestedAgentRunning = (feed: ActivityFeed) =>
  feed.entries.some(
    (entry) =>
      entry.kind === "tool" &&
      entry.tool === "Agent" &&
      entry.agentId !== undefined &&
      entry.result === undefined,
  );

function linkStopped(feed: ActivityFeed, agentId: string, agentType: unknown): FoldResult {
  if (
    linkedNode(feed, agentId) !== undefined ||
    !hasSteps(feed, agentId) ||
    nestedAgentRunning(feed)
  ) {
    return unchangedFeed(feed);
  }
  const [only, ...others] = runningUnlinked(feed).filter((entry) => entry.agentType === agentType);
  if (only === undefined || others.length > 0) return unchangedFeed(feed);
  return followedBy(replaced(feed, only, { ...only, agentId }), (next) =>
    recredit(next, agentId, only.nodeId),
  );
}

function finishSubagent(feed: ActivityFeed, payload: Record<string, unknown>): FoldResult {
  const call = agentCallOf({ kind: "SubagentStop", payload });
  const agentId = payload["agent_id"];
  if (call?.background === true || typeof agentId !== "string") return unchangedFeed(feed);
  const running = runningWhere(feed, (entry) => entry.agentId === agentId);
  return running === undefined
    ? linkStopped(feed, agentId, payload["agent_type"])
    : replaced(feed, running, { ...running, state: "finished" });
}

const outputOf = (response: unknown): string | undefined =>
  typeof response === "string" ? response : (JSON.stringify(response) as string | undefined);

function endStep(
  feed: ActivityFeed,
  payload: Record<string, unknown>,
  failed: boolean,
): FoldResult {
  const toolUseId = payload["tool_use_id"];
  const step = feed.entries.find(
    (entry): entry is ToolEntry =>
      entry.kind === "tool" && entry.toolUseId === toolUseId && entry.result === undefined,
  );
  if (typeof toolUseId !== "string" || step === undefined) return unchangedFeed(feed);
  const output = failed ? payload["error"] : outputOf(payload["tool_response"]);
  const childAgentId =
    failed || payload["tool_name"] !== "Agent"
      ? undefined
      : agentCallOf({ kind: "PostToolUse", payload })?.agentId;
  const reported = payload["duration_ms"];
  const stamp = payload["flowdeck_hook_at"];
  const durationMs =
    typeof reported === "number"
      ? reported
      : typeof stamp === "number"
        ? stamp - step.at
        : undefined;
  const replacedStep = replaced(feed, step, {
    ...step,
    ...(typeof output === "string" ? { output: previewOf(output) } : {}),
    result: failed ? "error" : "ok",
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(childAgentId === undefined ? {} : { childAgentId }),
  });
  const ended = keeping(
    replacedStep,
    cutOf(step.id, "output", typeof output === "string" ? output : undefined),
  );
  return childAgentId === undefined
    ? ended
    : followedBy(ended, (next) => recredit(next, childAgentId, step.nodeId));
}

function endToolCall(
  feed: ActivityFeed,
  windows: readonly NodeWindow[],
  payload: Record<string, unknown>,
): FoldResult {
  return followedBy(endStep(feed, payload, false), (next) =>
    addPullRequest(next, windows, payload),
  );
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
        : endToolCall(feed, windows, event.payload);
    case "PostToolUseFailure":
      return endStep(feed, event.payload, true);
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
  if (event.kind !== "done" || !turnNodes.has(nodeId)) return unchangedFeed(feed);
  const message = event.payload?.stopMessage?.trim() ?? "";
  return added(feed, {
    ...common,
    kind: "turn",
    summary: message === "" ? "Turn ended" : cut(message),
  });
}
