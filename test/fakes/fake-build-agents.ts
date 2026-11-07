import { join } from "node:path";
import { emptyReport, type BuildReport } from "../../src/core/compiler/build-report.js";
import { markerOf } from "../../src/core/run/agent-calls.js";
import type { FileSystem } from "../../src/ports/file-system.js";
import type {
  BuildAgents,
  BuildAgentsOpenSpec,
  BuildTurnResult,
} from "../../src/ports/build-agents.js";

type Scripted = { path: string; rounds?: number[] };

export type FakeBuildScript = {
  leaveMarker?: Scripted[];
  editCodeOwned?: Scripted[];
  questions?: BuildReport["questions"];
  merges?: BuildReport["merges"];
  keptApart?: BuildReport["keptApart"];
  failTurn?: string;
  aliveAfterRestart?: boolean;
};

export type FakeBuildTurn = { sessionName: string; text: string };

const unfilledLine = /^@unfilled.*\n\n?/m;
const descriptionLine = /^description: (.*)$/m;
const frontmatterEnd = /^---\n[\s\S]*?\n---\n/;
const filledDescription =
  " Filled by the fake build agents with a description long enough to pass the checker.";

const inRound = (scripted: Scripted, round: number) =>
  scripted.rounds === undefined || scripted.rounds.includes(round);

const filled = (draft: string, keepMarker: boolean): string => {
  const described = draft.replace(descriptionLine, (_line, raw: string) => {
    const parsed: unknown = JSON.parse(raw);
    return `description: ${JSON.stringify(`${String(parsed)}${filledDescription}`)}`;
  });
  const body = `${described.replace(unfilledLine, "")}\nFilled by the fake build agents.\n`;
  if (!keepMarker) return body;
  const marker = unfilledLine.exec(draft)?.[0] ?? "@unfilled: left by the fake.\n\n";
  return body.replace(frontmatterEnd, (head) => `${head}${marker}`);
};

export class FakeBuildAgents implements BuildAgents {
  readonly opened: BuildAgentsOpenSpec[] = [];
  readonly turns: FakeBuildTurn[] = [];
  readonly closed: string[] = [];
  private readonly live = new Map<string, BuildAgentsOpenSpec>();
  private readonly pieceRounds = new Map<string, number>();

  constructor(private readonly options: { fs: FileSystem; script?: FakeBuildScript }) {}

  readonly open: BuildAgents["open"] = async (spec) => {
    this.opened.push(spec);
    this.live.set(spec.sessionName, spec);
  };

  readonly turn: BuildAgents["turn"] = async (
    sessionName,
    text,
    onCall,
  ): Promise<BuildTurnResult> => {
    this.turns.push({ sessionName, text });
    const script = this.options.script ?? {};
    if (script.failTurn !== undefined) return { kind: "failed", reason: script.failTurn };
    const round = this.turns.filter((turn) => turn.sessionName === sessionName).length;
    const workspaceDir = this.live.get(sessionName)?.workspaceDir;

    for (const line of text.split("\n")) {
      const marker = markerOf(line);
      if (!("piece" in marker)) continue;
      const { piece } = marker;
      onCall({ piece });
      if (workspaceDir !== undefined) await this.fill(workspaceDir, piece);
      onCall({ piece, status: "completed" });
    }

    if (workspaceDir !== undefined) {
      for (const scripted of script.editCodeOwned ?? []) {
        if (!inRound(scripted, round)) continue;
        const path = join(workspaceDir, scripted.path);
        await this.options.fs.writeFile(path, `${await this.options.fs.readFile(path)}\n`);
      }
      const report: BuildReport = {
        ...emptyReport(),
        questions: script.questions ?? [],
        merges: script.merges ?? [],
        keptApart: script.keptApart ?? [],
      };
      await this.options.fs.writeFile(
        join(workspaceDir, "build-report.json"),
        JSON.stringify(report, null, 2),
      );
    }
    return { kind: "stopped" };
  };

  readonly alive: BuildAgents["alive"] = async (sessionName) =>
    this.live.has(sessionName) ||
    (!this.closed.includes(sessionName) && this.options.script?.aliveAfterRestart === true);

  readonly close: BuildAgents["close"] = async (sessionName) => {
    this.closed.push(sessionName);
    this.live.delete(sessionName);
  };

  private async fill(workspaceDir: string, piece: string) {
    const path = join(workspaceDir, piece);
    if (!(await this.options.fs.exists(path))) return;
    const round = (this.pieceRounds.get(piece) ?? 0) + 1;
    this.pieceRounds.set(piece, round);
    const keepMarker = (this.options.script?.leaveMarker ?? []).some(
      (scripted) => scripted.path === piece && inRound(scripted, round),
    );
    await this.options.fs.writeFile(path, filled(await this.options.fs.readFile(path), keepMarker));
  }
}
