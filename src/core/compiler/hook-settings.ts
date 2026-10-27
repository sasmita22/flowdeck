type HookEntry = { hooks: { type: "command"; command: string }[] }[];

export type HookSettings = {
  hooks: {
    Stop: HookEntry;
    PreToolUse: HookEntry;
    PostToolUse: HookEntry;
    SubagentStop: HookEntry;
  };
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookSettings(options: { nodePath: string; hookScriptPath: string }): HookSettings {
  const command = `${shellQuote(options.nodePath)} ${shellQuote(options.hookScriptPath)}`;
  const entry: HookEntry = [{ hooks: [{ type: "command", command }] }];
  return { hooks: { Stop: entry, PreToolUse: entry, PostToolUse: entry, SubagentStop: entry } };
}
