import { z } from "zod";
import { latestLibraries, type FlowStore } from "../flow/flow-store.js";
import { flowSvg } from "../flow/flow-svg.js";
import { expandLibraries, LibraryError, libraryLookup } from "../flow/libraries.js";
import { mainFlowOnly } from "../flow/main-flow.js";
import type { Flow, SessionContainer } from "../flow/schema.js";
import { isWorkflow, libraryBuildReason } from "../flow/structure.js";
import { foundVariables, type VariableValues } from "../flow/variables.js";
import type { FolderState } from "../flow/workspace-info.js";
import type { AgentCall } from "../run/agent-calls.js";
import {
  isValidBranchName,
  legacyBranchName,
  requestBranchSchema,
  type RequestBranch,
} from "../run/branch-name.js";
import {
  sessionBranch,
  type BuildEvent,
  type BuildSessionEvent,
  type BuildStepNumber,
  type ComponentStatus,
  type SessionBranch,
} from "../run/build-progress.js";
import { teardownWorkspace, type TeardownDeps } from "../run/delete-build.js";
import type { BuildSource, Store } from "../run/store.js";
import { sessionWorktree, type RunWorktree } from "../run/workspace.js";
import { layDown, lockBuild, workspaceDir, type BuildDeps, type BuildResult } from "./build.js";
import {
  buildAnswerSchema,
  parseBuildReport,
  type BuildAnswer,
  type BuildReport,
} from "./build-report.js";
import { buildSessionSettings } from "./build-session.js";
import {
  auditPiece,
  auditTurn,
  manifestNodes,
  nodeIdsOf,
  pieceKind,
  writeTurn,
} from "./build-turns.js";
import { canonicalJson } from "./canonical-json.js";
import { checkBuild, failureLine, type BuildCheckFailure } from "./check-build.js";
import { reportPath, type ContainerBranch } from "./emit.js";
import { sha256Hex } from "./hash.js";
import { shellQuote } from "./hook-settings.js";
import type { BuildFile, Manifest } from "./lower.js";
import { applyMerges } from "./merge.js";
import { containerRoot, containerSlugs } from "./pieces.js";
import { applyShared, sharedContainer, sharedPath } from "./shared.js";
import { buildRecord } from "./record.js";
import { rule as libraryLabels } from "./rules/library-labels.js";
import { rule as libraryLoops } from "./rules/library-loops.js";
import { rule as libraryUse } from "./rules/library-use.js";
import { validate, type ValidationError } from "./validate.js";
import { workspaceListing, workspaceRootFiles } from "./verify.js";

export type BuildRequest = {
  name: string;
  repo?: string;
  base?: string;
  branch?: RequestBranch;
  buildModel?: string;
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
    | "addBuildWorktree"
  >;
  gitState: {
    read(folder: string): Promise<FolderState>;
    defaultBranch(repo: string): Promise<string>;
    branches(repo: string): Promise<string[]>;
    checkedOutBranches(repo: string): Promise<Record<string, string>>;
  };
  worktree: TeardownDeps["worktree"] & { add(options: RunWorktree): Promise<void> };
  newId: () => string;
  now: () => number;
  agents: {
    open(spec: {
      sessionName: string;
      claudeSessionId: string;
      workspaceDir: string;
      sessionSlugs: readonly string[];
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
  flows: Pick<FlowStore, "loadLatest">;
};

const kebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const withDefaults = (flow: Flow, values: VariableValues): VariableValues => ({
  ...Object.fromEntries(
    foundVariables(flow).flatMap((variable) =>
      variable.kind === "yes-no" ? [[variable.name, false]] : [],
    ),
  ),
  ...values,
});

const emptyTextVariables = (flow: Flow, values: VariableValues): string[] =>
  foundVariables(flow)
    .filter((variable) => variable.kind === "text")
    .filter((variable) => values[variable.name] === undefined || values[variable.name] === "")
    .map((variable) => variable.name);

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

const busy: Record<"name", (name: string) => string> = {
  name: (name) => `A build named ${name} is already building.`,
};

async function branchProblem(
  branch: RequestBranch,
  repo: string,
  deps: BuildFlowDeps,
): Promise<string | undefined> {
  if (!isValidBranchName(branch.name)) return `${branch.name} is not a valid branch name.`;
  const local = await untilStopped(deps.signal, deps.gitState.branches(repo));
  const exists = local.includes(branch.name);
  if (branch.mode === "new") {
    return exists
      ? `Branch ${branch.name} already exists. Pick another name, or choose Existing branch.`
      : undefined;
  }
  if (!exists) return `Branch ${branch.name} does not exist locally.`;
  const checkedOut = await untilStopped(deps.signal, deps.gitState.checkedOutBranches(repo));
  const where = checkedOut[branch.name];
  return where === undefined
    ? undefined
    : `Branch ${branch.name} is checked out in ${where}. Switch that checkout to another branch, or pick a new branch.`;
}

async function requestProblems(
  request: BuildRequest,
  flow: Flow,
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
  const sessions = sessionsOf(flow);
  for (const { container } of sessions) {
    const state = await untilStopped(deps.signal, deps.gitState.read(container.repo));
    if (state.kind === "missing" || state.kind === "not-a-repo") {
      const problem = state.kind === "missing" ? "does not exist" : "is not a git repository";
      return [{ rule: "build-repo", message: `${container.repo} ${problem}.` }];
    }
  }
  const unset = emptyTextVariables(flow, request.values);
  if (unset.length > 0) {
    return [{ rule: "build-values", message: `Give a value for ${unset.join(", ")}.` }];
  }
  if (request.branch === undefined) return [];
  for (const session of sessions) {
    const branch = await branchProblem(
      sessionRequestBranch(request.branch, session, sessions.length),
      session.container.repo,
      deps,
    );
    if (branch !== undefined) return [{ rule: "build-branch", message: branch }];
  }
  return [];
}

export const buildInputsSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.boolean()])),
  repo: z.string().optional(),
  base: z.string().optional(),
  branch: requestBranchSchema.optional(),
  buildModel: z.string().optional(),
  answers: z.array(buildAnswerSchema).optional(),
});

export type BuildInputs = z.infer<typeof buildInputsSchema>;

export type BuildOrigin = {
  source: BuildSource;
  blueprint: { name: string; version: number };
  request?: BuildInputs;
};

const requestBase = ({ base, branch }: BuildRequest): string | undefined =>
  branch?.mode === "new" ? branch.base : base;

const isSession = (container: Flow["containers"][number]): container is SessionContainer =>
  container.kind === "session";

type SessionOf = { container: SessionContainer; slug: string };

const sessionsOf = (flow: Flow): SessionOf[] => {
  const slugs = containerSlugs(flow);
  return flow.containers
    .filter(isSession)
    .map((container) => ({ container, slug: slugs.get(container.id) ?? container.id }));
};

const ownBranch = (dialogBranch: string, slug: string) => `${dialogBranch}-${slug}`;

const sessionRequestBranch = (
  branch: RequestBranch,
  { container, slug }: SessionOf,
  sessions: number,
): RequestBranch =>
  sessions === 1
    ? branch
    : { mode: "new", name: ownBranch(branch.name, slug), base: container.branch };

const sessionBranchOf = (
  { branch, branchCreated }: SessionBranch,
  slug: string,
  sessions: number,
): SessionBranch =>
  sessions === 1
    ? { branch, branchCreated }
    : { branch: ownBranch(branch, slug), branchCreated: true };

const withRequestTarget = (flow: Flow, request: BuildRequest): Flow => {
  const { repo, buildModel } = request;
  const base = requestBase(request);
  const single = flow.containers.filter(isSession).length === 1;
  return {
    ...flow,
    containers: flow.containers.map((container) =>
      single && isSession(container)
        ? {
            ...container,
            ...(repo === undefined ? {} : { repo }),
            ...(base === undefined ? {} : { branch: base }),
          }
        : container,
    ),
    settings: { ...flow.settings, ...(buildModel === undefined ? {} : { buildModel }) },
  };
};

export type StartedBuild = { kind: "started"; pendingId: string };

type StartBuildResult = { ok: false; errors: ValidationError[] } | (StartedBuild & { flow: Flow });

const libraryRules = new Set([libraryUse.id, libraryLabels.id, libraryLoops.id]);

type Expansion = { ok: false; errors: ValidationError[] } | { ok: true; flow: Flow };

const expandedHost = (saved: Flow, deps: BuildFlowDeps): Expansion => {
  const resolve = latestLibraries(deps.flows);
  const lookup = libraryLookup(resolve);
  const host = mainFlowOnly(saved, lookup);
  const errors = [
    ...validate(saved, lookup).filter((error) => error.rule === libraryLoops.id),
    ...validate(host, lookup).filter(
      (error) => libraryRules.has(error.rule) && error.rule !== libraryLoops.id,
    ),
  ];
  if (errors.length > 0) return { ok: false, errors };
  try {
    return { ok: true, flow: expandLibraries(host, resolve).flow };
  } catch (error) {
    if (!(error instanceof LibraryError)) throw error;
    return { ok: false, errors: [{ rule: libraryUse.id, message: error.message }] };
  }
};

export async function startBuild(
  saved: Flow,
  request: BuildRequest,
  deps: BuildFlowDeps,
  origin?: BuildOrigin,
  frozen?: Flow,
): Promise<StartBuildResult> {
  if (!isWorkflow(saved)) {
    return { ok: false, errors: [{ rule: "build-library", message: libraryBuildReason }] };
  }
  const expanded: Expansion =
    frozen === undefined ? expandedHost(saved, deps) : { ok: true, flow: frozen };
  if (!expanded.ok) return expanded;
  const flow = mainFlowOnly(withRequestTarget(expanded.flow, request));
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const problems = await requestProblems(request, flow, deps).catch((error: unknown) => {
    if (error instanceof BuildStopped) return undefined;
    throw error;
  });
  if (problems === undefined) return stoppedResult;
  if (problems.length > 0) return { ok: false, errors: problems };
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
            svg: flowSvg(saved),
            flow: expanded.flow,
          },
        }),
  });
  if (start.kind === "busy") {
    return {
      ok: false,
      errors: [{ rule: `build-${start.reason}`, message: busy[start.reason](request.name) }],
    };
  }
  return { ...start, flow: expanded.flow };
}

const manifestPath = "manifest.json";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const labelsOf = (manifest: Manifest, path: string): string[] =>
  manifestNodes(manifest).flatMap((node) => (node.file === path ? [node.label] : []));

const maxRounds = 3;

const manifestOf = (files: readonly BuildFile[]): Manifest =>
  JSON.parse(files.find((file) => file.path === manifestPath)?.content ?? "{}") as Manifest;

const sharedFile = (manifest: Manifest, entry: BuildReport["shared"][number]): string[] => {
  const container = sharedContainer(manifest.containers, entry);
  return container === undefined ? [] : [sharedPath(entry, containerRoot(container))];
};

const templateFolder = /^(workspace|sessions\/[^/]+)\/plugin\/templates\//;

const componentsOf = (
  manifest: Manifest,
  files: readonly BuildFile[],
  shared: BuildReport["shared"] = [],
): string[] => [
  ...new Set(
    manifestNodes(manifest).flatMap((node) =>
      node.type === "agent" && node.file !== undefined ? [node.file] : [],
    ),
  ),
  ...files.flatMap((file) => (templateFolder.test(file.path) ? [file.path] : [])),
  ...shared.flatMap((entry) => sharedFile(manifest, entry)),
];

const componentStatus = (call: AgentCall): ComponentStatus => {
  if (call.status === undefined) return "running";
  return call.status === "completed" ? "done" : "failed";
};

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

const requestedBranch = (request: BuildRequest, buildId: string): SessionBranch =>
  request.branch === undefined
    ? { branch: legacyBranchName(request.name, buildId), branchCreated: true }
    : { branch: request.branch.name, branchCreated: request.branch.mode === "new" };

export async function runBuild(
  { pendingId }: StartedBuild,
  saved: Flow,
  request: BuildRequest,
  deps: BuildFlowDeps,
  origin?: BuildOrigin,
  resume?: BuildResume,
): Promise<BuildResult> {
  const flow = mainFlowOnly(withRequestTarget(saved, request));
  const sessions = sessionsOf(flow);
  let current: BuildStepNumber = resume === undefined ? 1 : 3;
  let report: unknown;
  let workspace: { dir: string; worktrees: RunWorktree[] } | undefined;
  let session: string | undefined;
  let opening: string | undefined;
  let recorded = false;
  let failureAppended = false;
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
    const baseOf = async ({ container }: SessionOf) =>
      container.branch === ""
        ? await waited(deps.gitState.defaultBranch(container.repo))
        : container.branch;
    const { id, bases } =
      resume === undefined
        ? await stage(1, async () => {
            const bases: string[] = [];
            for (const session of sessions) bases.push(await baseOf(session));
            return { id: deps.newId(), bases };
          })
        : {
            id: resume.session.buildId,
            bases: sessions.map(({ container }) =>
              sessions.length === 1 ? resume.session.base : container.branch,
            ),
          };
    const dialogBranch =
      resume === undefined
        ? requestedBranch(request, id)
        : sessionBranch(resume.session, request.name, id);
    const dir = workspaceDir(deps.home, id);
    const cuts = sessions.map(({ container, slug }, index) => {
      const { branch, branchCreated } = sessionBranchOf(dialogBranch, slug, sessions.length);
      const worktree: RunWorktree = {
        repo: container.repo,
        base: bases[index] ?? "",
        branch,
        create: branchCreated,
        path: sessionWorktree(dir, slug, container.repo),
      };
      return { slug, worktree };
    });
    const single = cuts.length === 1 ? cuts[0]?.worktree : undefined;
    const identity = {
      id,
      name: request.name,
      values: withDefaults(flow, request.values),
      repo: single?.repo ?? null,
      base: single?.base ?? null,
      branch: single?.branch ?? null,
      branchCreated: single?.create ?? null,
    };
    const branches: Record<string, ContainerBranch> = Object.fromEntries(
      cuts.map(({ slug, worktree }) => [
        slug,
        { branch: worktree.branch, branchCreated: worktree.create },
      ]),
    );
    if (resume === undefined) {
      current = 2;
      append({ type: "step", step: 2, status: "running" });
    } else {
      opening = resume.session.name;
      workspace = { dir, worktrees: [] };
      for (const { worktree } of cuts) {
        if (!(await deps.fs.exists(worktree.path))) {
          throw new Error(`The build's worktree ${worktree.path} is gone.`);
        }
      }
      workspace = { dir, worktrees: cuts.map(({ worktree }) => worktree) };
    }
    const realDir = await settled(deps.fs.realPath(dir));
    const laidDown = await waited(
      layDown(flow, {
        home: deps.home,
        kitVersion: deps.kit.version,
        ...(origin === undefined ? {} : { source: origin.source }),
        workspace: {
          ...identity,
          branches,
          realDir,
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
      workspace = { dir, worktrees: [] };
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
      for (const { slug, worktree } of cuts) {
        const cut = {
          path: worktree.path,
          branch: worktree.branch,
          base: worktree.base,
          branchCreated: worktree.create,
        };
        try {
          await deps.worktree.add(worktree);
        } catch (error) {
          append({ type: "worktree", status: "failed", ...cut, message: messageOf(error) });
          failureAppended = true;
          throw error;
        }
        workspace = { dir, worktrees: [...(workspace?.worktrees ?? []), worktree] };
        deps.store.addBuildWorktree(id, {
          container: slug,
          repo: worktree.repo,
          base: worktree.base,
          branch: worktree.branch,
          branchCreated: worktree.create,
          path: worktree.path,
        });
        append({ type: "worktree", status: "done", ...cut });
      }
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
        repo: identity.repo ?? "",
        base: identity.base ?? "",
        values: identity.values,
        branch: dialogBranch.branch,
        branchCreated: dialogBranch.branchCreated,
        model: flow.settings.buildModel,
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
      sessionSlugs: sessionsOf(flow).map(({ slug }) => slug),
      kitDir: deps.kit.dir,
      settingsPath: deps.settingsPath,
      model: flow.settings.buildModel,
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
        kind: piece === auditPiece ? "workspace" : pieceKind(piece),
        nodeIds: nodeIdsOf(manifest, piece),
        labels: labelsOf(manifest, piece),
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
              ...sharedFile(manifest, entry),
              ...entry.usedBy.flatMap(
                (id) => manifestNodes(manifest).find((node) => node.id === id)?.file ?? [],
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
    if (!failureAppended) {
      append({ type: "step", step: current, status: "failed", message: messageOf(error) });
    }
    try {
      await tearDown();
    } finally {
      end("failed");
    }
    if (stopped()) return stoppedResult;
    throw error;
  }
}
