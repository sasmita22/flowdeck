import { z } from "zod";
import type { FlowStore, SavedFlowRef } from "../flow/flow-store.js";
import { flowSvg } from "../flow/flow-svg.js";
import { mainFlowOnly } from "../flow/main-flow.js";
import type { BuildConfig, Flow } from "../flow/schema.js";
import { unsetVariables, type VariableValues } from "../flow/variables.js";
import type { FolderState } from "../flow/workspace-info.js";
import type { AgentCall } from "../run/agent-calls.js";
import type {
  BuildEvent,
  BuildSessionEvent,
  BuildStepNumber,
  ComponentStatus,
} from "../run/build-progress.js";
import { teardownWorkspace, type TeardownDeps } from "../run/delete-build.js";
import type { BuildSource, Store } from "../run/store.js";
import { buildWorktree, type RunWorktree } from "../run/workspace.js";
import { layDown, lockBuild, workspaceDir, type BuildDeps, type BuildResult } from "./build.js";
import {
  buildAnswerSchema,
  parseBuildReport,
  type BuildAnswer,
  type BuildReport,
} from "./build-report.js";
import { buildSessionSettings } from "./build-session.js";
import { auditTurn, nodeIdsOf, pieceKind, writeTurn } from "./build-turns.js";
import { canonicalJson } from "./canonical-json.js";
import { checkBuild, type BuildCheckFailure } from "./check-build.js";
import { resolveConnectors } from "./connectors.js";
import { reportPath } from "./emit.js";
import { sha256Hex } from "./hash.js";
import { shellQuote } from "./hook-settings.js";
import type { BuildFile, Manifest } from "./lower.js";
import { applyMerges } from "./merge.js";
import { applyShared, sharedPath } from "./shared.js";
import { buildRecord } from "./record.js";
import { validate, type ValidationError } from "./validate.js";
import { workspaceListing, workspaceRootFiles } from "./verify.js";

export type BuildRequest = {
  name: string;
  repo?: string;
  base?: string;
  values: VariableValues;
  answers?: readonly BuildAnswer[];
};

export type BuildFlowDeps = Omit<BuildDeps, "source" | "workspace"> & {
  fs: BuildDeps["fs"] & TeardownDeps["fs"];
  store: Pick<
    Store,
    | "recordBuild"
    | "findBuildByName"
    | "startPendingBuild"
    | "appendBuildEvent"
    | "endPendingBuild"
    | "findPendingBuildByName"
  >;
  gitState: {
    read(folder: string): Promise<FolderState>;
    defaultBranch(repo: string): Promise<string>;
  };
  worktree: TeardownDeps["worktree"] & { add(options: RunWorktree): Promise<void> };
  newId: () => string;
  now: () => number;
  agents: {
    open(spec: {
      sessionName: string;
      claudeSessionId: string;
      workspaceDir: string;
      kitDir: string;
      settingsPath: string;
      model?: string;
      env: Readonly<Record<string, string>>;
      attach?: true;
    }): Promise<void>;
    turn(
      sessionName: string,
      text: string,
      onCall: (call: AgentCall) => void,
    ): Promise<{ kind: "stopped" } | { kind: "failed"; reason: string }>;
    close(sessionName: string): Promise<void>;
  };
  kit: { dir: string; version: string };
  sessionName: () => string;
  newSessionId: () => string;
  settingsPath: string;
  guardCommand: string;
  hookCommand: string;
  onEvent?: (pendingId: string, event: BuildEvent) => void;
  signal?: AbortSignal;
};

export type BuildVersionDeps = BuildFlowDeps & { flows: Pick<FlowStore, "load"> };

const kebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const refused = (rule: string, message: string): BuildResult => ({
  ok: false,
  errors: [{ rule, message }],
});

const withDefaults = (buildConfig: BuildConfig, values: VariableValues): VariableValues => ({
  ...Object.fromEntries(
    buildConfig.variables.flatMap((variable) =>
      variable.default === undefined ? [] : [[variable.name, variable.default]],
    ),
  ),
  ...values,
});

export const stoppedRule = "build-stopped";

const stoppedResult = {
  ok: false as const,
  errors: [{ rule: stoppedRule, message: "The build was stopped." }],
};

class BuildStopped extends Error {
  constructor() {
    super("build stopped");
  }
}

const untilStopped = <T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> => {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BuildStopped());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

const busy: Record<"blueprint" | "name", (name: string) => string> = {
  blueprint: () => "This blueprint is already building.",
  name: (name) => `A build named ${name} is already building.`,
};

async function requestProblems(
  request: BuildRequest,
  repo: string,
  buildConfig: BuildConfig,
  deps: BuildFlowDeps,
): Promise<ValidationError[]> {
  if (!kebabCase.test(request.name)) {
    return [
      {
        rule: "build-name",
        message: `"${request.name}" is not a build name: use lowercase letters, digits and single hyphens, like fix-login.`,
      },
    ];
  }
  if (deps.store.findBuildByName(request.name) !== undefined) {
    return [{ rule: "build-name", message: `A build named ${request.name} already exists.` }];
  }
  if (deps.store.findPendingBuildByName(request.name) !== undefined) {
    return [{ rule: "build-name", message: busy.name(request.name) }];
  }
  const state = await untilStopped(deps.signal, deps.gitState.read(repo));
  if (state.kind === "missing" || state.kind === "not-a-repo") {
    const problem = state.kind === "missing" ? "does not exist" : "is not a git repository";
    return [{ rule: "build-repo", message: `${repo} ${problem}.` }];
  }
  const unset = unsetVariables(buildConfig, request.values);
  return unset.length === 0
    ? []
    : [{ rule: "build-values", message: `Give a value for ${unset.join(", ")}.` }];
}

export const buildInputsSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.boolean()])),
  repo: z.string().optional(),
  base: z.string().optional(),
  buildModel: z.string().optional(),
  answers: z.array(buildAnswerSchema).optional(),
});

export type BuildInputs = z.infer<typeof buildInputsSchema>;

export type BuildOrigin = {
  source: BuildSource;
  blueprint: { name: string; version: number };
  request?: BuildInputs;
};

const withRequestTarget = (flow: Flow, { repo, base }: BuildRequest): Flow => ({
  ...flow,
  session: {
    ...flow.session,
    buildConfig: {
      ...flow.session.buildConfig,
      ...(repo === undefined ? {} : { repo }),
      ...(base === undefined ? {} : { base }),
    },
  },
});

export type StartedBuild = { kind: "started"; pendingId: string };

export type StartBuildResult = { ok: false; errors: ValidationError[] } | StartedBuild;

export async function startBuild(
  saved: Flow,
  request: BuildRequest,
  deps: BuildFlowDeps,
  origin?: BuildOrigin,
): Promise<StartBuildResult> {
  const flow = mainFlowOnly(withRequestTarget(saved, request));
  const { buildConfig } = flow.session;
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const problems = await requestProblems(request, buildConfig.repo ?? "", buildConfig, deps).catch(
    (error: unknown) => {
      if (error instanceof BuildStopped) return undefined;
      throw error;
    },
  );
  if (problems === undefined) return stoppedResult;
  if (problems.length > 0) return { ok: false, errors: problems };
  const connectors = await resolveConnectors(flow.session.connectors, deps.connectors);
  if (!connectors.ok) return connectors;
  if (deps.signal?.aborted === true) return stoppedResult;
  const start = deps.store.startPendingBuild({
    flowId: origin?.source.flowId ?? `file:${request.name}`,
    version: origin?.source.version ?? 1,
    name: request.name,
    origin: origin ?? null,
    startedAt: deps.now(),
    ...(origin === undefined
      ? {}
      : {
          snapshot: {
            blueprintName: origin.blueprint.name,
            version: origin.blueprint.version,
            flow: saved,
            svg: flowSvg(saved),
          },
        }),
  });
  if (start.kind === "busy") {
    return {
      ok: false,
      errors: [{ rule: `build-${start.reason}`, message: busy[start.reason](request.name) }],
    };
  }
  return start;
}

const manifestPath = "manifest.json";

const maxRounds = 3;

const manifestOf = (files: readonly BuildFile[]): Manifest =>
  JSON.parse(files.find((file) => file.path === manifestPath)?.content ?? "{}") as Manifest;

const componentsOf = (
  manifest: Manifest,
  files: readonly BuildFile[],
  shared: BuildReport["shared"] = [],
): string[] => [
  ...new Set(
    manifest.nodes.flatMap((node) =>
      node.type === "agent" && node.file !== undefined ? [node.file] : [],
    ),
  ),
  ...files.flatMap((file) => (file.path.startsWith("plugin/templates/") ? [file.path] : [])),
  ...shared.map(sharedPath),
];

const componentStatus = (call: AgentCall): ComponentStatus => {
  if (call.status === undefined) return "running";
  return call.status === "completed" ? "done" : "failed";
};

const failureLine = (failure: BuildCheckFailure) =>
  `${failure.file} ${failure.rule}: ${failure.detail}`;

export const questionRule = "build-question";

const questionErrors = (report: BuildReport): ValidationError[] =>
  report.questions.map((question) => ({
    rule: questionRule,
    message: `${question.nodeId}: ${question.text}`,
  }));

const lockedFiles = (back: readonly BuildFile[], manifest: Manifest): BuildFile[] => {
  const content = back.filter((file) => file.path !== manifestPath);
  const files = Object.fromEntries(
    content
      .filter((file) => file.path !== reportPath)
      .map((file) => [file.path, sha256Hex(file.content)]),
  );
  return [...content, { path: manifestPath, content: canonicalJson({ ...manifest, files }) }];
};

export type BuildResume = { session: BuildSessionEvent; round: number; turnsSent: number };

export const buildResumeOf = (events: readonly BuildEvent[]): BuildResume | undefined => {
  const session = events.findLast((event) => event.type === "session");
  const step = events.findLast((event) => event.type === "step");
  if (session?.type !== "session" || step?.type !== "step") return undefined;
  if (step.step !== 3 || step.status !== "running") return undefined;
  if (events.some((event) => event.type === "merge")) return undefined;
  const turnsSent = events.filter(
    (event) =>
      event.type === "step" && event.status === "running" && (event.step === 3 || event.step === 4),
  ).length;
  return { session, round: step.round ?? 1, turnsSent };
};

export const resumeRequest = (name: string, session: BuildSessionEvent): BuildRequest => ({
  name,
  repo: session.repo,
  base: session.base,
  values: session.values,
});

export async function runBuild(
  { pendingId }: StartedBuild,
  saved: Flow,
  request: BuildRequest,
  deps: BuildFlowDeps,
  origin?: BuildOrigin,
  resume?: BuildResume,
): Promise<BuildResult> {
  const flow = mainFlowOnly(withRequestTarget(saved, request));
  const { buildConfig } = flow.session;
  const repo = buildConfig.repo ?? "";
  let current: BuildStepNumber = resume === undefined ? 1 : 3;
  let report: unknown;
  let workspace: { dir: string; worktree?: RunWorktree } | undefined;
  let session: string | undefined;
  let opening: string | undefined;
  let recorded = false;
  const stopped = () => !recorded && deps.signal?.aborted === true;
  const checkpoint = () => {
    if (stopped()) throw new BuildStopped();
  };
  const settled = async <T>(work: Promise<T>): Promise<T> => {
    const value = await work;
    checkpoint();
    return value;
  };
  const waited = <T>(work: Promise<T>): Promise<T> => settled(untilStopped(deps.signal, work));
  const append = (event: BuildEvent) => {
    if (stopped()) return;
    deps.store.appendBuildEvent(pendingId, event);
    deps.onEvent?.(pendingId, event);
  };
  const stage = async <T>(step: BuildStepNumber, work: () => Promise<T>): Promise<T> => {
    current = step;
    append({ type: "step", step, status: "running" });
    const value = await work();
    append({ type: "step", step, status: "done" });
    return value;
  };
  const end = (outcome: "built" | "needs-you" | "failed", buildId?: string) =>
    deps.store.endPendingBuild(
      pendingId,
      stopped()
        ? { outcome: "stopped", endedAt: deps.now() }
        : {
            outcome,
            endedAt: deps.now(),
            ...(buildId === undefined ? {} : { buildId }),
            ...(report === undefined ? {} : { report }),
          },
    );
  const closeSession = async () => {
    const name = session ?? opening;
    session = undefined;
    opening = undefined;
    try {
      if (name !== undefined) await deps.agents.close(name);
    } finally {
      await deps.fs.removeTree(deps.settingsPath.slice(0, deps.settingsPath.lastIndexOf("/")));
    }
  };
  const tearDown = async () => {
    try {
      await closeSession();
    } finally {
      if (workspace !== undefined) await teardownWorkspace(deps, workspace);
      workspace = undefined;
    }
  };
  const stop = async (
    outcome: "needs-you" | "failed",
    errors: ValidationError[],
  ): Promise<BuildResult> => {
    await tearDown();
    end(outcome);
    return stopped() ? stoppedResult : { ok: false, errors };
  };

  try {
    checkpoint();
    const { id, base } =
      resume === undefined
        ? await stage(1, async () => ({
            id: deps.newId(),
            base: buildConfig.base ?? (await waited(deps.gitState.defaultBranch(repo))),
          }))
        : { id: resume.session.buildId, base: resume.session.base };
    const identity = {
      id,
      name: request.name,
      values: withDefaults(buildConfig, request.values),
      repo,
      base,
    };
    const dir = workspaceDir(deps.home, id);
    const worktree = { repo, base, ...buildWorktree({ id, name: request.name, repo, dir }) };
    if (resume === undefined) {
      current = 2;
      append({ type: "step", step: 2, status: "running" });
    } else {
      opening = resume.session.name;
      workspace = { dir };
      if (!(await deps.fs.exists(worktree.path))) {
        throw new Error(`The build's worktree ${worktree.path} is gone.`);
      }
      workspace = { dir, worktree };
    }
    const laidDown = await waited(
      layDown(flow, {
        home: deps.home,
        kitVersion: deps.kit.version,
        ...(deps.connectors === undefined ? {} : { connectors: deps.connectors }),
        ...(origin === undefined ? {} : { source: origin.source }),
        workspace: {
          ...identity,
          ...(origin === undefined ? {} : { blueprint: origin.blueprint }),
        },
      }),
    );
    if (!laidDown.ok && resume !== undefined) {
      throw new Error(laidDown.errors.map((error) => error.message).join("\n"));
    }
    if (!laidDown.ok) {
      append({
        type: "step",
        step: 2,
        status: "failed",
        message: laidDown.errors.map((error) => error.message).join("\n"),
      });
      end("failed");
      return laidDown;
    }
    if (resume === undefined) {
      workspace = { dir };
      for (const file of laidDown.files) {
        await settled(deps.fs.writeFile(`${dir}/${file.path}`, file.content));
      }
      append({ type: "step", step: 2, status: "done" });
    }
    let files = laidDown.files;
    let manifest = manifestOf(files);
    let latest: BuildReport = parseBuildReport(
      files.find((file) => file.path === reportPath)?.content ?? "{}",
    );
    report = latest;
    if (resume === undefined) {
      await deps.worktree.add(worktree);
      workspace = { dir, worktree };
    }

    current = 3;
    const sessionName = resume?.session.name ?? deps.sessionName();
    const claudeSessionId = resume?.session.claudeSessionId ?? deps.newSessionId();
    if (resume === undefined) {
      append({
        type: "session",
        name: sessionName,
        claudeSessionId,
        buildId: id,
        repo,
        base,
        values: identity.values,
      });
      await settled(
        deps.fs.writeFile(
          deps.settingsPath,
          JSON.stringify(
            buildSessionSettings({
              guardCommand: `${deps.guardCommand} ${shellQuote(dir)}`,
              hookCommand: deps.hookCommand,
            }),
            null,
            2,
          ),
        ),
      );
    }
    opening = sessionName;
    const opened = deps.agents.open({
      sessionName,
      claudeSessionId,
      workspaceDir: dir,
      kitDir: deps.kit.dir,
      settingsPath: deps.settingsPath,
      ...(buildConfig.buildModel === undefined ? {} : { model: buildConfig.buildModel }),
      env: {},
      ...(resume === undefined ? {} : { attach: true as const }),
    });
    await (resume === undefined ? opened : untilStopped(deps.signal, opened));
    session = sessionName;
    checkpoint();

    const readReport = async () => {
      latest = parseBuildReport(await waited(deps.fs.readFile(`${dir}/${reportPath}`)));
      report = latest;
    };
    const component = (piece: string, status: ComponentStatus) =>
      append({
        type: "component",
        path: piece,
        kind: piece === "workspace" ? "workspace" : pieceKind(piece),
        nodeIds: nodeIdsOf(manifest, piece),
        status,
      });
    const turn = async (text: string): Promise<string | undefined> => {
      const result = await waited(
        deps.agents.turn(sessionName, text, (call) => {
          if (call.piece !== undefined) component(call.piece, componentStatus(call));
        }),
      );
      if (result.kind === "failed") return `The build session's turn failed: ${result.reason}`;
      await readReport();
      return undefined;
    };
    const turnFailed = (step: 3 | 4, message: string, round?: number) => {
      append({
        type: "step",
        step,
        status: "failed",
        message,
        ...(round === undefined ? {} : { round }),
      });
      return stop("failed", [{ rule: "build-turn", message }]);
    };
    const asked = () => latest.questions.length > 0;

    let shared: BuildReport["shared"] = [];
    if (resume !== undefined && resume.round > 1) {
      await readReport();
      const kept = applyShared(files, manifest, latest.shared);
      files = kept.files;
      manifest = kept.manifest;
      shared = kept.accepted;
    }
    let failures: BuildCheckFailure[] = [];
    let pieces = componentsOf(manifest, files);
    for (let round = resume?.round ?? 1; ; round++) {
      current = 3;
      const inFlight = resume?.round === round;
      if (inFlight) await readReport();
      else {
        append({ type: "step", step: 3, status: "running", round });
        for (const piece of pieces) component(piece, "waiting");
      }
      const written = inFlight
        ? undefined
        : await turn(writeTurn(manifest, pieces, round, failures, request.answers));
      if (written !== undefined) return await turnFailed(3, written, round);
      append({ type: "step", step: 3, status: "done", round });
      if (asked()) return await stop("needs-you", questionErrors(latest));

      if (round === 1) {
        current = 4;
        append({ type: "step", step: 4, status: "running" });
        const audited = await turn(auditTurn(manifest, request.answers));
        if (audited !== undefined) return await turnFailed(4, audited);
        if (asked()) {
          append({ type: "step", step: 4, status: "done" });
          return await stop("needs-you", questionErrors(latest));
        }
        const merged = applyMerges(files, manifest, latest.merges);
        const laidShared = applyShared(merged.files, merged.manifest, latest.shared);
        const rejected = [...merged.rejected, ...laidShared.rejected];
        if (rejected.length > 0) {
          latest = { ...latest, questions: [...latest.questions, ...rejected] };
          report = latest;
          append({ type: "step", step: 4, status: "done" });
          return await stop("needs-you", questionErrors(latest));
        }
        if (merged.mergedPieces.length > 0) {
          const before = new Map(files.map((file) => [file.path, file.content]));
          const kept = new Set(merged.files.map((file) => file.path));
          for (const file of files) {
            if (!kept.has(file.path)) await settled(deps.fs.remove(`${dir}/${file.path}`));
          }
          for (const file of merged.files) {
            if (merged.mergedPieces.includes(file.path) || before.get(file.path) !== file.content)
              await settled(deps.fs.writeFile(`${dir}/${file.path}`, file.content));
          }
          for (const piece of merged.mergedPieces)
            append({ type: "merge", nodeIds: nodeIdsOf(merged.manifest, piece), piece });
          files = merged.files;
          manifest = merged.manifest;
        }
        if (laidShared.accepted.length > 0) {
          const before = new Map(files.map((file) => [file.path, file.content]));
          for (const file of laidShared.files) {
            if (before.get(file.path) !== file.content)
              await settled(deps.fs.writeFile(`${dir}/${file.path}`, file.content));
          }
          files = laidShared.files;
          manifest = laidShared.manifest;
          shared = laidShared.accepted;
        }
        const rewrite = [
          ...new Set([
            ...merged.mergedPieces,
            ...shared.flatMap((entry) => [
              sharedPath(entry),
              ...entry.usedBy.flatMap(
                (id) => manifest.nodes.find((node) => node.id === id)?.file ?? [],
              ),
            ]),
          ]),
        ];
        if (rewrite.length > 0) {
          const rewritten = await turn(
            writeTurn(manifest, rewrite, 1, [], request.answers, shared),
          );
          if (rewritten !== undefined) return await turnFailed(4, rewritten);
          if (asked()) {
            append({ type: "step", step: 4, status: "done" });
            return await stop("needs-you", questionErrors(latest));
          }
        }
        append({ type: "step", step: 4, status: "done" });
      }

      current = 5;
      append({ type: "step", step: 5, status: "running", round });
      const listing = await waited(
        workspaceListing(deps.fs, dir, [...workspaceRootFiles, reportPath]),
      );
      const back =
        listing === undefined
          ? []
          : await waited(
              Promise.all(
                listing.paths.map(async (path) => ({ path, content: await listing.read(path) })),
              ),
            );
      failures = checkBuild({ laidDown: files, readBack: back, manifest, flow, shared });
      if (failures.length === 0) {
        const { hash, manifest: locked } = await settled(
          lockBuild(deps.fs, dir, lockedFiles(back, manifest)),
        );
        const record = buildRecord(dir, locked, identity);
        checkpoint();
        deps.store.recordBuild(record);
        recorded = true;
        append({ type: "step", step: 5, status: "done", round });
        try {
          await closeSession();
        } finally {
          end("built", id);
        }
        return { ok: true, hash, dir, record };
      }
      const lines = failures.map(failureLine);
      append({ type: "step", step: 5, status: "failed", round, message: lines.join("\n") });
      append({ type: "check-failed", round, failures: lines });
      if (round === maxRounds) {
        return await stop(
          "failed",
          lines.map((message) => ({ rule: "build-check", message })),
        );
      }
      pieces = componentsOf(manifest, files, shared).filter((piece) =>
        failures.some((failure) => failure.file === piece),
      );
    }
  } catch (error) {
    if (recorded) throw error;
    append({
      type: "step",
      step: current,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await tearDown();
    } finally {
      end("failed");
    }
    if (stopped()) return stoppedResult;
    throw error;
  }
}

export async function buildFlow(
  saved: Flow,
  request: BuildRequest,
  deps: BuildFlowDeps,
  origin?: BuildOrigin,
): Promise<BuildResult> {
  const started = await startBuild(saved, request, deps, origin);
  if ("errors" in started) return started;
  return runBuild(started, saved, request, deps, origin);
}

export async function buildVersion(
  ref: SavedFlowRef,
  request: BuildRequest,
  deps: BuildVersionDeps,
): Promise<BuildResult> {
  const saved = deps.flows.load(ref);
  if (saved === null) {
    return refused("version", `${ref.flowId} has no saved version ${ref.version}`);
  }
  return buildFlow(saved.flow, request, deps, {
    source: { flowId: ref.flowId, version: ref.version },
    blueprint: { name: saved.name, version: saved.version },
  });
}
