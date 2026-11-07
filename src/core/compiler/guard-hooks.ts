import type { BuildFile } from "./lower.js";
import { standardRules } from "./standard-rules.js";

export const noForcePushPath = "plugin/hooks/no-force-push.sh";
export const rulesAfterCompactPath = "plugin/hooks/rules-after-compact.sh";

const deny = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Force pushes rewrite shared history; this build never force pushes.",
  },
});

const forcePush = String.raw`git[[:space:]]+push([^"]|\\")*([[:space:]]-f([[:space:]]|"|$)|[[:space:]]--force)`;

const noForcePush = [
  "#!/usr/bin/env bash",
  "input=$(cat)",
  `if printf '%s' "$input" | grep -Eq '${forcePush}'; then`,
  `  printf '%s\\n' '${deny}'`,
  "fi",
  "exit 0",
  "",
].join("\n");

const rulesAfterCompact = [
  "#!/usr/bin/env bash",
  "cat <<'FLOWDECK_RULES'",
  "These rules still apply after the conversation was compacted:",
  "",
  `${standardRules.text}FLOWDECK_RULES`,
  "",
].join("\n");

export function guardHookFiles(): BuildFile[] {
  return [
    { path: noForcePushPath, content: noForcePush },
    { path: rulesAfterCompactPath, content: rulesAfterCompact },
  ];
}
