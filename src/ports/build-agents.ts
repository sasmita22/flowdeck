import type { AgentCall } from "../core/run/agent-calls.js";

export type BuildAgentsOpenSpec = {
  sessionName: string;
  claudeSessionId: string;
  workspaceDir: string;
  kitDir: string;
  settingsPath: string;
  model?: string;
  env: Readonly<Record<string, string>>;
  attach?: true;
};

export type BuildTurnResult = { kind: "stopped" } | { kind: "failed"; reason: string };

export interface BuildAgents {
  open(spec: BuildAgentsOpenSpec): Promise<void>;
  turn(
    sessionName: string,
    text: string,
    onCall: (call: AgentCall) => void,
  ): Promise<BuildTurnResult>;
  alive(sessionName: string): Promise<boolean>;
  close(sessionName: string): Promise<void>;
}
