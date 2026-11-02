const prefixOf = (nodeId: string) => `${nodeId} failed: `;

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function plainCause(cause: string): string {
  const code = /^exit code (-?\d+)$/.exec(cause);
  if (code !== null) return `Script exited with code ${code[1]}`;
  if (cause === "killed by a signal") return "Script was stopped by a signal";
  const inner = /^(\S+) failed: (.*)$/s.exec(cause);
  if (inner !== null) return `${inner[1]} failed: ${plainCause(inner[2] ?? "")}`;
  return capitalized(cause);
}

export function plainReason(nodeId: string, message: string): string {
  const prefix = prefixOf(nodeId);
  return plainCause(message.startsWith(prefix) ? message.slice(prefix.length) : message);
}
