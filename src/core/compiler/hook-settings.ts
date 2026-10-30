type HookEntry = { hooks: { type: "command"; command: string; timeout?: number }[] }[];

export type HookSettings = {
  hooks: {
    Stop: HookEntry;
    PreToolUse: HookEntry;
    PostToolUse: HookEntry;
    SubagentStop: HookEntry;
    PermissionRequest: HookEntry;
  };
};

export const permissionHookTimeoutSeconds = 86_400;

const permissionDeadlineMs = (permissionHookTimeoutSeconds - 60) * 1000;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookSettings(options: { nodePath: string; hookScriptPath: string }): HookSettings {
  const command = `${shellQuote(options.nodePath)} ${shellQuote(options.hookScriptPath)}`;
  const entry: HookEntry = [{ hooks: [{ type: "command", command }] }];
  const permission: HookEntry = [
    {
      hooks: [
        {
          type: "command",
          command: `${command} --permission-deadline-ms=${permissionDeadlineMs}`,
          timeout: permissionHookTimeoutSeconds,
        },
      ],
    },
  ];
  return {
    hooks: {
      Stop: entry,
      PreToolUse: entry,
      PostToolUse: entry,
      SubagentStop: entry,
      PermissionRequest: permission,
    },
  };
}
