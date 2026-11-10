const prefixOf = (nodeId: string) => `${nodeId} failed: `;

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function plainCause(cause: string): string {
  const inner = /^(\S+) failed: (.*)$/s.exec(cause);
  if (inner !== null) return `${inner[1]} failed: ${plainCause(inner[2] ?? "")}`;
  if (/^\S+ wasn't written by /.test(cause)) return cause;
  return capitalized(cause);
}

export function plainReason(nodeId: string, message: string): string {
  const prefix = prefixOf(nodeId);
  return plainCause(message.startsWith(prefix) ? message.slice(prefix.length) : message);
}
