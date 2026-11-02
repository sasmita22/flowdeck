import { contextWindows } from "../run/context.js";

export type Choice = { value: string; label: string };

const aliases: Choice[] = [
  { value: "sonnet", label: "Sonnet (latest)" },
  { value: "opus", label: "Opus (latest)" },
  { value: "haiku", label: "Haiku (latest)" },
];

export const modelChoices: readonly Choice[] = [
  ...aliases,
  ...Object.keys(contextWindows).map((id) => ({ value: id, label: id })),
];

export const agentModelChoices: readonly Choice[] = [
  { value: "", label: "Same as the session" },
  ...modelChoices,
];

export const permissionModes: readonly Choice[] = [
  { value: "default", label: "Ask before risky actions" },
  { value: "acceptEdits", label: "Accept file edits without asking" },
  { value: "plan", label: "Plan only, change nothing" },
  { value: "bypassPermissions", label: "Never ask (skip all checks)" },
];
