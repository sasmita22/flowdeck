export type HookSettings = {
  hooks: { Stop: { hooks: { type: "command"; command: string }[] }[] };
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookSettings(options: { nodePath: string; hookScriptPath: string }): HookSettings {
  const command = `${shellQuote(options.nodePath)} ${shellQuote(options.hookScriptPath)}`;
  return { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } };
}
