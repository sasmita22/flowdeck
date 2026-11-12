import { basename } from "node:path";

type Deny = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};

const allowedHosts = new Set(["github.com", "raw.githubusercontent.com"]);
const readable =
  "Only github.com and raw.githubusercontent.com links or files on this machine can be read";

const deny = (reason: string): Deny => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

const webProtocols = new Set(["https:", "http:"]);

function urlOf(input: unknown): { raw: string; url: URL } | undefined {
  const raw = (input as { tool_input?: { url?: unknown } } | null)?.tool_input?.url;
  if (typeof raw !== "string") return undefined;
  try {
    return { raw, url: new URL(raw) };
  } catch {
    return undefined;
  }
}

const isWebLink = (raw: string, url: URL) => !raw.includes("\\") && webProtocols.has(url.protocol);

const hasNoExtras = (url: URL) => url.port === "" && url.username === "" && url.password === "";

export function webGuardDecision(input: unknown): Deny | undefined {
  const parsed = urlOf(input);
  if (parsed === undefined) return deny(`${readable}.`);
  const { raw, url } = parsed;
  if (!isWebLink(raw, url)) return deny(`${readable}.`);
  if (!allowedHosts.has(url.hostname)) return deny(`${readable}; ${url.hostname} is not allowed.`);
  return hasNoExtras(url) ? undefined : deny(`${readable}.`);
}

if (basename(process.argv[1] ?? "").startsWith("flowdeck-web-guard")) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on("end", () => {
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      input = undefined;
    }
    const decision = webGuardDecision(input);
    if (decision !== undefined) process.stdout.write(JSON.stringify(decision) + "\n");
  });
}
