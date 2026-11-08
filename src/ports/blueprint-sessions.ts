export type BlueprintSessionSpec = {
  session: string;
  cwd: string;
  settingsPath: string;
  mcpConfigPath: string;
  kitDir: string;
  socketPath: string;
};

export interface BlueprintSessions {
  start(spec: BlueprintSessionSpec): Promise<void>;
  stop(session: string): Promise<void>;
  alive(session: string): Promise<boolean>;
}
